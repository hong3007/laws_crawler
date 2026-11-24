// 폰 앱의 수집·저장·검색 로직. PC의 law.py 와 같은 규칙 (한쪽 고치면 다른 쪽도).
// db = sqlite-wasm oo1.DB, 법제처 API는 폰 브라우저에서 직접 호출 (CORS 허용됨).

export const LABEL = {
  law: "법령", admrul: "행정규칙", ordin: "자치법규", prec: "판례", detc: "헌재결정례", expc: "법령해석례",
  decc: "행정심판례", nfaCgmExpc: "소방청 해석", moisCgmExpc: "행정안전부 해석", moelCgmExpc: "고용노동부 해석",
  molitCgmExpc: "국토교통부 해석",
};
const TITLE = ["법령명한글", "행정규칙명", "자치법규명", "사건명", "안건명", "조약명"];
const DATE = ["공포일자", "발령일자", "선고일자", "종국일자", "회신일자", "해석일자", "의결일자", "시행일자"];
const KIND = ["법령구분명", "행정규칙종류", "자치법규종류", "제개정구분명", "사건종류명"];
const ORG = ["소관부처명", "해석기관명", "회신기관명", "법원명", "재결청", "지자체기관명"];
const GID = ["법령ID", "행정규칙ID", "자치법규ID"];
const SKIP_TREE = new Set(["부칙", "개정문", "기본정보", "행정규칙기본정보", "자치법규기본정보", "첨부파일", "조문제목"]);
const SKIP_SUFFIX = ["키", "코드", "여부", "링크", "일자", "번호", "일시", "ID", "파일명"];
export const NO_BODY = "(본문 제공 안 됨)";
export const SCHEMA = `
create table if not exists docs(target, serial, gid, title, date, kind, org, link, meta, fetched,
                                primary key(target, serial));
create virtual table if not exists fts using fts5(title, body, tokenize='trigram');
create table if not exists changes(at, target, title, kind, old_date, new_date, old_serial, new_serial);
create table if not exists meta(key primary key, value);`;

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
export function text(o, key = "") {
  if (Array.isArray(o)) return o.flatMap(v => text(v, key));
  if (o && typeof o === "object") {
    const kv = Object.entries(o).sort((a, b) => (typeof a[1] === "object") - (typeof b[1] === "object"));
    return kv.filter(([k]) => !SKIP_TREE.has(k)).flatMap(([k, v]) => text(v, k));
  }
  const s = str(o).replace(/<[^>]+>/g, "").trim();
  return !s || /^\d+$/.test(s) || SKIP_SUFFIX.some(x => key.endsWith(x)) ? [] : [s];
}

export async function api(page, params, oc) {
  const url = `https://www.law.go.kr/DRF/${page}?` + new URLSearchParams({ ...params, OC: oc, type: "JSON" });
  for (let i = 0; ; i++) {
    let raw;
    try { raw = await (await fetch(url)).text(); }
    catch (e) { if (i === 2) throw new Error("인터넷 연결 확인: " + e.message); await sleep(3000 * (i + 1)); continue; }
    try { return JSON.parse(raw); }
    catch { // 보통 '미신청된 목록' 안내 HTML
      throw new Error(raw.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "빈 응답");
    }
  }
}

export async function bodyOf(link, oc) {
  const q = Object.fromEntries(new URL(link, "https://www.law.go.kr").searchParams);
  const root = Object.values(await api("lawService.do", q, oc))[0];
  return root && typeof root === "object" ? text(root).join("\n") : NO_BODY;
}

// 1건 저장. 이미 본문까지 있으면 false. 같은 법령의 옛 버전은 changes에 기록하고 지움.
export async function save(db, target, it, fetchBody) {
  const serial = ends(it, "일련번호");
  const link = ends(it, "상세링크").replace(/OC=[^&]*&?/, "");
  const row = db.selectArray("select d.rowid, f.body from docs d join fts f on f.rowid=d.rowid where target=? and serial=?", [target, serial]);
  if (row && row[1]) return false;
  let body = "";
  try { body = await fetchBody(link); } catch (e) { console.warn("본문 실패", serial, e); }  // 빈 본문 → 다음에 다시
  const title = first(it, TITLE) || serial, date = first(it, DATE).replace(/\D/g, "").slice(0, 8);
  const kind = [...new Set(KIND.map(k => str(it[k])).filter(Boolean))].join(" ");
  if (row) db.exec("update fts set body=? where rowid=?", { bind: [body, row[0]] });
  else {
    const gid = first(it, GID);
    db.transaction(() => {
      for (const [rid, , oldDate, oldSerial] of db.selectArrays(
        "select rowid, title, date, serial from docs where target=? and gid=? and gid!=''", [target, gid])) {
        db.exec("insert into changes values(?,?,?,?,?,?,?,?)", { bind: [now(), target, title, kind, oldDate, date, oldSerial, serial] });
        db.exec("delete from docs where rowid=?", { bind: [rid] });
        db.exec("delete from fts where rowid=?", { bind: [rid] });
      }
      db.exec("insert into docs values(?,?,?,?,?,?,?,?,?,?)", { bind: [target, serial, gid, title, date, kind, first(it, ORG), link, "", now()] });
      db.exec("insert into fts(rowid, title, body) values(last_insert_rowid(),?,?)", { bind: [title, body] });
    });
  }
  return true;
}

// 최신순으로 훑기. 끝까지 다 받은 적 있는 종류는 새 것 없는 페이지에서 멈춤. 2000건 이하는 매번 끝까지.
// report({t, state, seen, total, neu, title, msg}) — state: run 진행 / done 끝까지 받음 / uptodate 최신 / skip 건너뜀 / stop 중지
export async function crawl(db, targets, oc, report, stopped, fetchBody = link => bodyOf(link, oc)) {
  for (const t of targets) {
    const done = db.selectValue("select value from meta where key=?", ["done:" + t]);
    let page = 1, seen = 0, neu = 0, total = 0;
    const r = (state, extra) => report({ t, state, seen, total, neu, ...extra });
    r("run", { title: "목록 확인 중" });
    while (true) {
      let its;
      try { [total, its] = items(await api("lawSearch.do", { target: t, sort: "ddes", display: 100, page }, oc)); }
      catch (e) { r("skip", { msg: e.message }); break; }
      let pageNew = 0;
      for (const it of its) {
        if (stopped()) return r("stop");
        const title = first(it, TITLE);
        if (await save(db, t, it, fetchBody)) { pageNew++; neu++; await sleep(150); }
        seen++;
        r("run", { title });
      }
      if (!its.length || seen >= total) {
        db.exec("insert or replace into meta values(?,?)", { bind: ["done:" + t, now().slice(0, 10)] });
        r("done");
        break;
      }
      if (done && pageNew === 0 && total > 2000) { r("uptodate"); break; }
      page++;
    }
  }
}

export function search(db, q, limit = 0) {
  const words = q.split(/\s+/).filter(Boolean);
  const where = words.map(() => "(f.title like ? or f.body like ?)").join(" and ") || "1";
  const args = words.flatMap(w => [`%${w}%`, `%${w}%`]);
  return db.selectArrays(
    `select d.rowid, d.target, d.title, d.date, d.kind, d.org, f.body from docs d join fts f on f.rowid=d.rowid
     where ${where} order by (f.title like ?) desc, d.date desc` + (limit ? ` limit ${limit | 0}` : ""),
    [...args, words.length ? `%${words[0]}%` : ""]);
}

export function snippet(body, word, n = 40) {
  const i = word ? body.indexOf(word) : -1;
  return (i >= 0 ? body.slice(Math.max(0, i - n), i + n) : body.slice(0, n * 2)).replace(/\n/g, " ");
}

export function csv(rows) {  // 엑셀에서 한글 안 깨지게 BOM. LLM 프롬프트용으로 본문 전체
  const cell = v => /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = [["종류", "제목", "날짜", "구분", "기관", "본문"], ...rows.map(r => [LABEL[r[1]] || r[1], ...r.slice(2)])];
  return "﻿" + lines.map(l => l.map(cell).join(",")).join("\r\n");
}
