// DB 담당 일꾼(백그라운드 스레드). 폰 브라우저 전용 저장소(OPFS)에 law.db 를 두고 화면의 요청을 처리.
import sqlite3InitModule from "./sqlite/index.mjs";
import * as E from "./engine.js";

const FILE = "/law.db";
let pool, db, stop = false, running = false, paused = false;
const open = () => { db = new pool.OpfsSAHPoolDb(FILE); db.exec(E.SCHEMA); };
// 예전 저장 방식(색인에 본문까지, 압축 없음)으로 받은 DB인가 → 화면이 '비우고 처음부터' 안내 (변환 기능은 안 만듦)
const oldFormat = () => !!db.selectValue("select 1 from sqlite_master where name='fts' and sql not like '%detail%'");

// DB 파일은 한 번에 한 창(탭)만 열 수 있음 → 나중에 연 창이 넘겨받고, 먼저 열린 창은 멈춤
const bc = new BroadcastChannel("law-db");
bc.onmessage = ({ data }) => {
  if (data !== "release" || !pool || paused) return;
  stop = true;  // 받던 업데이트도 멈춤
  try { db?.close(); } catch {}
  db = null;
  pool.pauseVfs();
  paused = true;
  postMessage({ event: "paused" });
};

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  bc.postMessage("release");
  for (let i = 0; ; i++) {
    try {  // preserveOnInitFailure: 열기 실패해도 저장된 DB를 지우지 않음 (기본값은 지워 버림!)
      pool = await sqlite3.installOpfsSAHPoolVfs({ name: "law", preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true });
      break;
    } catch (e) {
      if (i >= 10) throw new Error("다른 창(탭)에서 이 DB를 쓰고 있습니다. 다른 창을 닫고 새로고침하세요.");
      await new Promise(r => setTimeout(r, 500));
    }
  }
  open();
})();

const ops = {
  stats() {
    return {
      counts: db.selectArrays("select target, count(*) from docs group by target order by 2 desc"),
      changes: db.selectArrays("select at, target, title, kind, old_date, new_date from changes order by at desc limit 30"),
      targets: JSON.parse(db.selectValue("select value from meta where key='targets'") || "null"),
      // done:<종류> = 끝까지 다 받은 적 있음, partial:<종류> = 지난번에 중간에 끊김 → 화면이 자동 업데이트 여부를 정함
      meta: Object.fromEntries(db.selectArrays("select key, value from meta where key like 'done:%' or key like 'partial:%'")),
      oldFormat: oldFormat(),
      size: db.selectValue("pragma page_count") * db.selectValue("pragma page_size"),  // 실제 DB 크기 (브라우저 집계는 부풀려짐)
      running,
    };
  },
  setTargets(list) { db.exec("insert or replace into meta values('targets', ?)", { bind: [JSON.stringify(list)] }); },
  async search(q, target, sort) {  // 끝의 r[1] = 종류 코드 (화면의 종류 거르기용)
    const w = E.parse(q).groups.flat();
    return (await E.search(db, q, 300, target, sort)).map(r => [r[0], E.LABEL[r[1]] || r[1], r[2], r[3], r[4], r[5], E.snippet(r[6], w), r[1]]);
  },
  async doc(id, oc) {  // ③ 요약만 저장한 종류(판례·자치법규)는 열 때 전문을 온라인으로, 안 되면 저장된 요약
    const [target, link] = db.selectArray("select target, link from docs where rowid=?", [id]) || [];
    if (E.SUMMARY[target] && oc) try { return await E.bodyOf(link, oc); } catch {}
    const body = await E.bodyText(db, id);
    return E.SUMMARY[target] ? body + "\n\n(요약만 저장됨 — 인터넷이 연결되면 전문을 보여 줍니다)" : body;
  },
  async csv(q, target, sort) { return E.csv(await E.search(db, q, 0, target, sort)); },
  async importFile(file) {  // PC에서 만든 DB 파일을 8MB씩 나눠 저장 (큰 파일도 메모리 안 터지게)
    if (running) throw new Error("업데이트 중에는 등록할 수 없습니다.");
    // 라이브러리는 기존 DB를 먼저 비운 뒤 파일을 검사함 → 잘못된 파일이면 폰 DB가 날아가므로 미리 확인
    const head = new TextDecoder().decode(await file.slice(0, 16).arrayBuffer());
    if (head !== "SQLite format 3\0" || file.size % 512) throw new Error("SQLite DB 파일이 아니거나 덜 받아진 파일입니다. 저장된 DB는 그대로입니다.");
    running = true;  // 등록하는 동안 업데이트 막기
    db.close();
    let off = 0;
    try {
      await pool.importDb(FILE, async () => {
        if (off >= file.size) return undefined;
        const b = await file.slice(off, off + (8 << 20)).arrayBuffer();
        off += b.byteLength;
        postMessage({ event: "log", text: `등록 중 ${Math.round(off / file.size * 100)}%` });
        return b;
      });
    } finally { open(); running = false; }
    return ops.stats();
  },
  exportDb() {  // 저장된 DB를 파일로 꺼냄 (백업·다른 기기 등록용). 받는 중엔 쓰는 도중이라 막음
    if (running) throw new Error("업데이트 중에는 저장할 수 없습니다. 중지한 뒤에 해 주세요.");
    return new Blob([pool.exportFile(FILE)], { type: "application/vnd.sqlite3" });
  },
  wipe() {  // 저장된 DB 비우고 처음부터. 받을 종류 설정은 남김 (API 키·테마는 화면 쪽 저장소라 그대로)
    if (running) throw new Error("업데이트 중에는 비울 수 없습니다. 중지한 뒤에 해 주세요.");
    const keep = db.selectValue("select value from meta where key='targets'");
    db.close();
    pool.unlink(FILE);
    open();
    if (keep) ops.setTargets(JSON.parse(keep));
    return ops.stats();
  },
  async update(targets, oc) {  // 같은 버튼 다시 누르면 중지
    if (running) { stop = true; return; }
    if (!targets) return;  // 이미 끝난 뒤 '중지'가 눌린 경우
    if (oldFormat()) throw new Error("예전 저장 방식의 DB입니다. ⚙ 맨 아래 '저장된 DB 비우고 처음부터'를 먼저 해 주세요.");
    running = true; stop = false;
    let last = 0;
    const report = p => {  // 진행 중 표시는 0.2초에 한 번만 (화면 버벅임 방지), 상태 바뀔 땐 바로
      if (p.state === "run" && Date.now() - last < 200) return;
      last = Date.now();
      postMessage({ event: "progress", p });
    };
    postMessage({ event: "start", targets });
    try { await E.crawl(db, targets, oc, report, () => stop); }
    finally { running = false; postMessage({ event: "done" }); }
  },
};

onmessage = async e => {
  const { id, op, args } = e.data;
  try {
    await ready;
    if (paused) throw new Error("다른 창에서 열려 이 창은 멈췄습니다.");
    postMessage({ id, result: await ops[op](...args) });
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });
  }
};
