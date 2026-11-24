// 웹앱의 수집·저장·검색 로직. PC의 law.py 와 같은 규칙 (한쪽 고치면 다른 쪽도).
// db = sqlite-wasm oo1.DB, 법제처 API는 브라우저에서 직접 호출 (CORS 허용됨).
// 용량 줄이기: ① 색인은 위치 정보 없이(detail=none) ② 본문은 압축(body.z)해 따로, 색인엔 본문을 안 넣음(content='')
//   ③ 판례·자치법규는 요약만 저장(SUMMARY), 전문은 열 때 온라인으로. → 검색 = 색인으로 후보 고르고 본문 풀어 확인

// 순서 = 받는 순서·화면 순서. 작고 중요한 것 먼저, 아주 큰 판례(17만)·자치법규(16만)는 맨 뒤
export const LABEL = {
  law: "법령", admrul: "행정규칙", expc: "법령해석례", nfaCgmExpc: "소방청 해석", moisCgmExpc: "행정안전부 해석",
  moelCgmExpc: "고용노동부 해석", molitCgmExpc: "국토교통부 해석", detc: "헌재결정례", decc: "행정심판례",
  prec: "판례", ordin: "자치법규",
};
const TITLE = ["법령명한글", "행정규칙명", "자치법규명", "사건명", "안건명", "조약명"];
const DATE = ["공포일자", "발령일자", "선고일자", "종국일자", "회신일자", "해석일자", "의결일자", "시행일자"];
const KIND = ["법령구분명", "행정규칙종류", "자치법규종류", "제개정구분명", "사건종류명"];
const ORG = ["소관부처명", "해석기관명", "회신기관명", "법원명", "재결청", "지자체기관명"];
const GID = ["법령ID", "행정규칙ID", "자치법규ID"];
const SKIP_TREE = new Set(["부칙", "개정문", "기본정보", "행정규칙기본정보", "자치법규기본정보", "첨부파일", "조문제목"]);
const SKIP_SUFFIX = ["키", "코드", "여부", "링크", "일자", "번호", "일시", "ID", "파일명"];
export const NO_BODY = "(본문 제공 안 됨)";
// ③ 요약만 저장할 종류: 이 칸들은 빼고 저장 (판례 전문, 자치법규 별표)
export const SUMMARY = { prec: ["판례내용"], ordin: ["별표"] };
// law.py 의 WEB_SCHEMA 와 같음 (PC가 만드는 등록용 DB 파일도 이 모양)
export const SCHEMA = `
create table if not exists docs(target, serial, gid, title, date, kind, org, link, meta, fetched,
                                primary key(target, serial));
create table if not exists body(rowid integer primary key, z blob);
create virtual table if not exists fts using fts5(title, body, tokenize='trigram', detail='none', content='', contentless_delete=1);
create table if not exists changes(at, target, title, kind, old_date, new_date, old_serial, new_serial);
create table if not exists meta(key primary key, value);`;

// 압축: zlib 형식('deflate') = Python zlib.compress 와 서로 읽힘
const pipe = async (data, stream) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
export const pack = s => pipe(s, new CompressionStream("deflate"));
export const unpack = async z => z ? new TextDecoder().decode(await pipe(z, new DecompressionStream("deflate"))) : "";
export const bodyText = (db, id) => unpack(db.selectValue("select z from body where rowid=?", [id]));

const str = v => (v == null ? "" : String(v)).trim();
const first = (it, keys) => { for (const k of keys) if (str(it[k])) return str(it[k]); return ""; };
const ends = (it, suf) => { for (const [k, v] of Object.entries(it)) if (k.endsWith(suf) && v) return String(v); return ""; };
const now = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 19).replace("T", " ");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 목록 응답 → [전체 건수, 항목들]. 대상마다 감싸는 키가 달라 모양으로 찾음. 1건이면 배열이 아니라 객체로 옴.
export function items(resp) {
  const root = Object.values(resp)[0];
  if (!root || typeof root !== "object") return [0, []];
  const total = parseInt(root.totalCnt) || 0;
  for (const v of Object.values(root)) if (v && typeof v === "object") return [total, Array.isArray(v) ? v : [v]];
  return [total, []];
}

// 본문 JSON → 읽는 순서대로 문장들. 문자열 값을 하위 묶음보다 먼저 (조 제목 → 항 → 호).
export function text(o, key = "", skip = SKIP_TREE) {
  if (Array.isArray(o)) return o.flatMap(v => text(v, key, skip));
  if (o && typeof o === "object") {
    const kv = Object.entries(o).sort((a, b) => (typeof a[1] === "object") - (typeof b[1] === "object"));
    return kv.filter(([k]) => !skip.has(k)).flatMap(([k, v]) => text(v, k, skip));
  }
  const s = str(o).replace(/<[^>]+>/g, "").trim();
  return !s || /^\d+$/.test(s) || SKIP_SUFFIX.some(x => key.endsWith(x)) ? [] : [s];
}

export async function api(page, params, oc) {
  const url = `https://www.law.go.kr/DRF/${page}?` + new URLSearchParams({ ...params, OC: oc, type: "JSON" });
  for (let i = 0; ; i++) {
    let raw;
    try { raw = await (await fetch(url, { signal: AbortSignal.timeout(30000) })).text(); }  // 30초 넘으면 포기·재시도
    catch (e) { if (i === 2) throw new Error("인터넷 연결 확인: " + e.message); await sleep(3000 * (i + 1)); continue; }
    try { return JSON.parse(raw); }
    catch { // 보통 '미신청된 목록' 안내 HTML
      throw new Error(raw.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "빈 응답");
    }
  }
}

// summaryOf = 요약 저장 종류면 그 종류 이름 (빼는 칸 추가), 없으면 전문
export async function bodyOf(link, oc, summaryOf) {
  const q = Object.fromEntries(new URL(link, "https://www.law.go.kr").searchParams);
  const root = Object.values(await api("lawService.do", q, oc))[0];
  const skip = SUMMARY[summaryOf] ? new Set([...SKIP_TREE, ...SUMMARY[summaryOf]]) : SKIP_TREE;
  return (root && typeof root === "object" && !Array.isArray(root) ? text(root, "", skip).join("\n") : "") || NO_BODY;
}

// 1건 저장. 이미 본문까지 있으면 false. 같은 법령의 옛 버전은 changes에 기록하고 지움.
// 현행만 저장: 같은 ID로 시행예정('연혁') 버전이 섞여 오는데, 두면 현행과 서로 지움. 시행일이 되면 현행으로 와서 개정 기록.
export async function save(db, target, it, fetchBody) {
  const status = first(it, ["현행연혁구분", "현행연혁코드"]);
  if (status && status !== "현행") return false;
  const serial = ends(it, "일련번호");
  const link = ends(it, "상세링크").replace(/OC=[^&]*&?/, "");
  // 본문 있음 = body.z 가 있음 (받기 실패한 건 z 없이 저장 → 다음에 다시 받음)
  const row = db.selectArray("select d.rowid, b.z is not null from docs d left join body b on b.rowid=d.rowid where target=? and serial=?", [target, serial]);
  if (row && row[1]) return false;
  let body = "";  // 저장하면 true, 본문 받기 실패면 "fail"
  try { body = await fetchBody(link, target); } catch (e) { console.warn("본문 실패", serial, e); }
  const title = first(it, TITLE) || serial, date = first(it, DATE).replace(/\D/g, "").slice(0, 8);
  const kind = [...new Set(KIND.map(k => str(it[k])).filter(Boolean))].join(" ");
  const z = body ? await pack(body) : null;  // 압축은 비동기라 트랜잭션 밖에서 미리
  db.transaction(() => {
    let rid = row?.[0];
    if (rid == null) {
      const gid = first(it, GID);
      for (const [old, , oldDate, oldSerial] of db.selectArrays(
        "select rowid, title, date, serial from docs where target=? and gid=? and gid!=''", [target, gid])) {
        db.exec("insert into changes values(?,?,?,?,?,?,?,?)", { bind: [now(), target, title, kind, oldDate, date, oldSerial, serial] });
        for (const t of ["docs", "body", "fts"]) db.exec(`delete from ${t} where rowid=?`, { bind: [old] });
      }
      db.exec("insert into docs values(?,?,?,?,?,?,?,?,?,?)", { bind: [target, serial, gid, title, date, kind, first(it, ORG), link, "", now()] });
      rid = db.selectValue("select last_insert_rowid()");
    } else db.exec("delete from fts where rowid=?", { bind: [rid] });  // 빈 본문으로 색인됐던 것 다시
    db.exec("insert or replace into body values(?,?)", { bind: [rid, z] });
    db.exec("insert into fts(rowid, title, body) values(?,?,?)", { bind: [rid, title, body] });
  });
  return body ? true : "fail";
}

// 최신순으로 훑기. 끝까지 다 받은 적 있고 지난번이 중간에 끊기지 않았으면(partial 없음) 새 것 없는 페이지에서 멈춤.
// 끊겼으면 다음엔 끝까지 훑어 빠진 구간을 채움. 2000건 이하는 매번 끝까지. (law.py crawl 과 같은 규칙)
// report({t, state, seen, total, neu, full, title, msg}) — state: run 진행 / done 끝까지 받음 / uptodate 최신 / skip 건너뜀 / stop 중지
//   full = 끝까지 훑는 중 (남은 시간 표시는 이때만 의미 있음)
export async function crawl(db, targets, oc, report, stopped, fetchBody = (link, t) => bodyOf(link, oc, t), pause = 150) {
  const meta = k => db.selectValue("select value from meta where key=?", [k]);
  const endPartial = failed => { if (!failed) db.exec("delete from meta where key=?", { bind: ["partial:" + t] }); };
  let t;
  for (t of targets) {
    const quick = !!meta("done:" + t) && !meta("partial:" + t);
    db.exec("insert or replace into meta values(?, '1')", { bind: ["partial:" + t] });
    let page = 1, seen = 0, neu = 0, total = 0, failed = false;  // 본문 실패 있으면 partial 남겨 다음에 다시
    const r = (state, extra) => report({ t, state, seen, total, neu, full: !quick, ...extra });
    r("run", { title: "목록 확인 중" });
    while (true) {
      let its;
      try { [total, its] = items(await api("lawSearch.do", { target: t, sort: "ddes", display: 100, page }, oc)); }
      catch (e) { r("skip", { msg: e.message }); break; }
      if (page === 1 && !its.length) { r("skip", { msg: "목록이 비어 있음" }); break; }  // 빈 응답을 '다 받음'으로 치지 않음
      // 한 페이지(100건)를 4건씩 동시에 받음. DB 쓰기는 한 줄씩이라 겹치지 않음
      // ponytail: 동시 4건 고정, 법제처가 막거나 느려지면 숫자를 줄일 것
      let pageNew = 0, next = 0;
      const one = async () => {
        while (next < its.length && !stopped()) {
          const it = its[next++], title = first(it, TITLE);
          const res = await save(db, t, it, fetchBody);
          if (res) { pageNew++; neu++; failed ||= res === "fail"; await sleep(pause); }
          seen++;
          r("run", { title });
        }
      };
      await Promise.all(Array.from({ length: 4 }, one));
      if (stopped()) return r("stop");
      if (!its.length || seen >= total) {
        db.exec("insert or replace into meta values(?,?)", { bind: ["done:" + t, now().slice(0, 10)] });
        endPartial(failed);
        r("done");
        break;
      }
      if (quick && pageNew === 0 && total > 2000) {
        endPartial(failed);
        r("uptodate");
        break;
      }
      page++;
    }
  }
}

// 검색: 3글자 이상 단어는 세 글자 조각(trigram)이 모두 든 문서를 색인으로 후보로 고르고,
// 본문을 풀어 단어가 정말 있는지 확인. 제목 일치 먼저, 그다음 최신순. limit 채우면 멈춤.
// ponytail: 모든 단어가 2글자 이하면 색인을 못 써서 전체를 풀어 봄 (흔한 단어는 금방 limit, 드문 2글자는 느림)
export async function search(db, q, limit = 0) {
  const words = q.split(/\s+/).filter(Boolean), low = words.map(w => w.toLowerCase());
  const tris = [...new Set(words.flatMap(w => { const c = [...w]; return c.slice(2).map((_, i) => c.slice(i, i + 3).join("")); }))];
  const match = tris.map(t => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  const tw = words.length ? `%${words[0].replace(/[\\%_]/g, "\\$&")}%` : "";
  const cand = db.selectArrays(
    `select d.rowid, d.target, d.title, d.date, d.kind, d.org from docs d
     ${match ? "where d.rowid in (select rowid from fts where fts match ?)" : ""}
     order by (d.title like ? escape '\\') desc, d.date desc`, match ? [match, tw] : [tw]);
  const out = [];
  for (const r of cand) {
    const body = await bodyText(db, r[0]);
    const hay = (r[2] + "\n" + body).toLowerCase();
    if (low.every(w => hay.includes(w))) { out.push([...r, body]); if (limit && out.length >= limit) break; }
  }
  return out;
}

export function snippet(body, word, n = 40) {
  const i = word ? body.indexOf(word) : -1;
  return (i >= 0 ? body.slice(Math.max(0, i - n), i + n) : body.slice(0, n * 2)).replace(/\n/g, " ");
}

export function csv(rows) {  // 엑셀에서 한글 안 깨지게 BOM. LLM 프롬프트용으로 본문 전체
  const cell = v => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const lines = [["종류", "제목", "날짜", "구분", "기관", "본문"], ...rows.map(r => [LABEL[r[1]] || r[1], ...r.slice(2)])];
  return "﻿" + lines.map(l => l.map(cell).join(",")).join("\r\n");
}
