# -*- coding: utf-8 -*-
"""
行政手続等の棚卸調査結果(令和7年度) Excel -> SQLite 変換スクリプト
出力: web/procedures.db  (sql.js でブラウザから読み込む)
"""
import openpyxl, sqlite3, os, re, sys, json, gzip, shutil

SRC = "20260826_procedures_survey_result_outline_02.xlsx"
OUT_DIR = "docs"
OUT_DB = os.path.join(OUT_DIR, "procedures.db")

os.makedirs(OUT_DIR, exist_ok=True)


def col_key(code):
    return "q" + str(code).replace("-", "_")


def to_int(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        try:
            return int(round(v))
        except Exception:
            return None
    s = str(v).strip().replace(",", "").replace("，", "")
    s = s.replace("回", "")
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    return None


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    codes = [str(c).strip() if c is not None else "" for c in next(rows)]
    labels = [str(c).strip() if c is not None else "" for c in next(rows)]
    keys = [col_key(c) for c in codes]

    # メタ情報 (列コード・ラベル対応) を JSON でも出力
    meta = [{"code": codes[i], "key": keys[i], "label": labels[i]} for i in range(len(keys))]
    with open(os.path.join(OUT_DIR, "columns.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    if os.path.exists(OUT_DB):
        os.remove(OUT_DB)
    con = sqlite3.connect(OUT_DB)
    cur = con.cursor()
    cur.execute("PRAGMA journal_mode=OFF")
    cur.execute("PRAGMA synchronous=OFF")

    coldefs = ", ".join('"%s" TEXT' % k for k in keys)
    cur.execute(
        "CREATE TABLE procedures (%s, total_count INTEGER, online_count INTEGER, "
        "offline_count INTEGER, search_text TEXT)" % coldefs
    )

    placeholders = ",".join(["?"] * (len(keys) + 4))
    ins = "INSERT INTO procedures VALUES (%s)" % placeholders

    i_name = keys.index("q2")
    i_law = keys.index("q3_1")
    i_art = keys.index("q3_2")
    i_id = keys.index("q0")
    i_tot = keys.index("q19_1")
    i_on = keys.index("q19_2")
    i_off = keys.index("q19_3")

    batch = []
    n = 0
    for r in rows:
        vals = [None if v is None else (str(v).strip() if not isinstance(v, str) else v.strip()) for v in r]
        # 列数を揃える
        if len(vals) < len(keys):
            vals += [None] * (len(keys) - len(vals))
        vals = vals[: len(keys)]
        if all(v in (None, "") for v in vals):
            continue
        tot = to_int(r[i_tot] if i_tot < len(r) else None)
        on = to_int(r[i_on] if i_on < len(r) else None)
        off = to_int(r[i_off] if i_off < len(r) else None)
        st = " ".join(
            str(vals[x]) for x in (i_id, i_name, i_law, i_art) if vals[x]
        )
        batch.append(tuple(vals) + (tot, on, off, st))
        n += 1
        if len(batch) >= 5000:
            cur.executemany(ins, batch)
            batch = []
    if batch:
        cur.executemany(ins, batch)

    con.commit()

    for k in ("q1", "q4", "q5", "q6", "q14_1", "q14_2", "q16_1", "q11"):
        cur.execute('CREATE INDEX idx_%s ON procedures("%s")' % (k, k))
    con.commit()
    cur.execute("VACUUM")
    con.commit()
    con.close()

    # sql.js 用に gzip 圧縮して配置（生 .db は削除）
    with open(OUT_DB, "rb") as fi, gzip.open(OUT_DB + ".gz", "wb", compresslevel=9) as fo:
        shutil.copyfileobj(fi, fo, length=1 << 20)
    raw = os.path.getsize(OUT_DB)
    gz = os.path.getsize(OUT_DB + ".gz")
    os.remove(OUT_DB)

    print("rows:", n)
    print("db (raw): %.1f MB / gz: %.1f MB" % (raw / 1e6, gz / 1e6))


if __name__ == "__main__":
    main()
