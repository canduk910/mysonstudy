/**
 * 모의고사 Q8–10 표(제목·머리 정보·행·각주) — 응시 화면(실전에서는 표만 보인다, §6-4)과 결과 화면이 같이 쓴다.
 * 표 칸은 영어(lang="en"), 종류 칩만 한국어.
 */

import { TOEIC_INFO_KIND_KO } from "@/lib/toeic-mock-contract";
import type { ToeicInfoTable } from "@/lib/toeic-attempt-contract";
import s from "./toeic-info-table.module.css";

export default function ToeicInfoTableView({ table }: { table: ToeicInfoTable }) {
  return (
    <div className={s.table} lang="en">
      <div className={s.head}>
        <p className={s.title}>{table.title}</p>
        <span className="u-chip" lang="ko">
          {TOEIC_INFO_KIND_KO[table.kind] ?? table.kind}
        </span>
      </div>
      {table.meta.length > 0 && (
        <ul className={s.meta}>
          {table.meta.map((m, k) => (
            <li key={k}>{m}</li>
          ))}
        </ul>
      )}
      <table className={s.rows}>
        <tbody>
          {table.rows.map((r, k) => (
            <tr key={k}>
              <th scope="row">{r.left}</th>
              <td>{r.right}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {table.notes.length > 0 && (
        <ul className={s.notes}>
          {table.notes.map((n, k) => (
            <li key={k}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
