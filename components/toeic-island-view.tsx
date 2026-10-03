"use client";

/**
 * 🏝️ 나만의 답변 섬 화면 (docs/harness/toeic.md §21-4, SPEC §20-18) — 클라이언트 컴포넌트.
 *
 * - 유형 탭 Q5–7 · Q11 → 소재별 묶음(groupIslandByTopic — 은행 소재 순서, 은행에 없는 소재는 이름 사본, "소재 없음"은 끝).
 * - 문장마다 쓰인 틀을 강조(islandHighlightSegments — templateRunSpans와 같은 일치 규칙), 🔊는 **탭할 때만**(speak — 프리페치 없음),
 *   한국어 단서·어디서 담았나·내가 말한 문장(접힘)·질문(접힘), ✏️ 고치기(섬 문장·메모·소재)·🗑 지우기(확인 한 번 — prod-guard 라우트).
 * - ✍️ 직접 쓰기: 영어 문장 + 한 줄 한국어 메모 + 소재 칩. 두 번 눌러도 한 개(clientId = 문서 id 원본 키 — 성공하면 새 키).
 * - AI 호출 0. 순서변경 없음(최근에 담은 것이 위).
 */

import { useMemo, useRef, useState } from "react";
import { speak } from "@/lib/speech";
import { formatKst } from "@/lib/kst";
import {
  TOEIC_ISLAND_EN_MAX,
  TOEIC_ISLAND_KO_MAX,
  TOEIC_ISLAND_PARTS,
  TOEIC_ISLAND_PART_LABEL_KO,
  groupIslandByTopic,
  islandHighlightSegments,
  islandOriginLabelKo,
  type ToeicIslandEntry,
  type ToeicIslandPart,
} from "@/lib/toeic-island";
import type {
  ToeicIslandCreateResponse,
  ToeicIslandDeleteResponse,
  ToeicIslandPatchResponse,
  ToeicIslandTopicChip,
} from "@/lib/toeic-island-contract";
import s from "./toeic-island.module.css";

const EN = "en-US";

function newClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "");
  } catch {
    /* 아래로 */
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function TopicChips({
  topics,
  value,
  onChange,
}: {
  topics: readonly ToeicIslandTopicChip[];
  value: string | null;
  onChange: (k: string | null) => void;
}) {
  return (
    <div className={s.chips} role="radiogroup" aria-label="소재">
      {topics.map((t) => (
        <button key={t.key} type="button" role="radio" aria-checked={value === t.key} className={`${s.chip} ${value === t.key ? s.chipOn : ""}`} onClick={() => onChange(t.key)}>
          {t.nameKo}
        </button>
      ))}
      <button type="button" role="radio" aria-checked={value === null} className={`${s.chip} ${value === null ? s.chipOn : ""}`} onClick={() => onChange(null)}>
        소재 없음
      </button>
    </div>
  );
}

function Highlighted({ text, templates }: { text: string; templates: readonly { key: string; frameEn: string }[] }) {
  const segs = useMemo(() => islandHighlightSegments(text, templates), [text, templates]);
  return (
    <>
      {segs.map((g, i) =>
        g.keys.length > 0 ? (
          <mark key={i} className={s.frameMark} title="외운 틀">
            {g.text}
          </mark>
        ) : (
          <span key={i}>{g.text}</span>
        ),
      )}
    </>
  );
}

export default function ToeicIslandView({
  initialEntries,
  initialPart,
  topicsByPart,
  templatesByPart,
}: {
  initialEntries: ToeicIslandEntry[];
  initialPart: ToeicIslandPart;
  topicsByPart: Record<ToeicIslandPart, ToeicIslandTopicChip[]>;
  /** 강조할 틀(틀 말하기 틀 + 공략 틀) — key·frameEn만 */
  templatesByPart: Record<ToeicIslandPart, { key: string; frameEn: string }[]>;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [part, setPart] = useState<ToeicIslandPart>(initialPart);

  // ── 직접 쓰기 ──
  const [en, setEn] = useState("");
  const [ko, setKo] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeMsg, setWriteMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const clientIdRef = useRef<string | null>(null);

  // ── 편집·삭제 ──
  const [editId, setEditId] = useState<string | null>(null);
  const [editEn, setEditEn] = useState("");
  const [editKo, setEditKo] = useState("");
  const [editTopic, setEditTopic] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const topics = topicsByPart[part] ?? [];
  const templates = templatesByPart[part] ?? [];
  const groups = groupIslandByTopic(entries, topics, part);
  const total = entries.filter((e) => e.part === part).length;

  function choosePart(p: ToeicIslandPart) {
    setPart(p);
    setTopic(null);
    setEditId(null);
    setConfirmId(null);
    try {
      window.history.replaceState(null, "", `?part=${p}`);
    } catch {
      /* 주소 기억은 편의 */
    }
  }

  function upsert(e: ToeicIslandEntry) {
    setEntries((cur) => [e, ...cur.filter((x) => x.id !== e.id)]);
  }

  async function submitWrite() {
    if (writeBusy) return;
    if (en.trim() === "") {
      setWriteMsg({ kind: "error", text: "영어 문장을 적어 주세요." });
      return;
    }
    if (clientIdRef.current === null) clientIdRef.current = newClientId();
    setWriteBusy(true);
    setWriteMsg(null);
    try {
      const res = await fetch("/api/toeic/island", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: { kind: "manual", clientId: clientIdRef.current }, part, en, ko: ko.trim() === "" ? null : ko, topicKey: topic }),
      });
      const data = (await res.json().catch(() => null)) as ToeicIslandCreateResponse | null;
      if (data?.ok) {
        upsert(data.entry);
        clientIdRef.current = null; // 다음 문장은 새 원본
        setEn("");
        setKo("");
        setWriteMsg({ kind: "ok", text: "🏝️ 섬에 담았어요." });
      } else {
        setWriteMsg({ kind: "error", text: data && !data.ok ? data.messageKo : "담지 못했어요." });
      }
    } catch {
      setWriteMsg({ kind: "error", text: "연결이 끊겨 담지 못했어요." });
    } finally {
      setWriteBusy(false);
    }
  }

  function startEdit(e: ToeicIslandEntry) {
    setEditId(e.id);
    setEditEn(e.en);
    setEditKo(e.ko ?? "");
    setEditTopic(e.topicKey);
    setConfirmId(null);
    setRowError(null);
  }

  async function saveEdit(e: ToeicIslandEntry) {
    setBusyId(e.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/toeic/island/${encodeURIComponent(e.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ en: editEn, ko: editKo.trim() === "" ? null : editKo, topicKey: editTopic }),
      });
      const data = (await res.json().catch(() => null)) as ToeicIslandPatchResponse | null;
      if (data?.ok) {
        setEntries((cur) => cur.map((x) => (x.id === e.id ? data.entry : x)));
        setEditId(null);
      } else {
        setRowError({ id: e.id, text: data && !data.ok ? data.messageKo : "고치지 못했어요." });
      }
    } catch {
      setRowError({ id: e.id, text: "연결이 끊겨 고치지 못했어요." });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(e: ToeicIslandEntry) {
    setBusyId(e.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/toeic/island/${encodeURIComponent(e.id)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as ToeicIslandDeleteResponse | null;
      if (data?.ok || (data && !data.ok && data.error === "not_found")) {
        setEntries((cur) => cur.filter((x) => x.id !== e.id));
        setConfirmId(null);
      } else {
        setRowError({ id: e.id, text: data && !data.ok ? data.messageKo : "지우지 못했어요." });
      }
    } catch {
      setRowError({ id: e.id, text: "연결이 끊겨 지우지 못했어요." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={s.wrap}>
      <div className={s.tabs} role="tablist" aria-label="유형">
        {TOEIC_ISLAND_PARTS.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={part === p}
            className={`${s.chip} ${part === p ? s.chipOn : ""}`}
            onClick={() => choosePart(p)}
          >
            {TOEIC_ISLAND_PART_LABEL_KO[p]} · {entries.filter((e) => e.part === p).length}
          </button>
        ))}
      </div>

      <section className={s.box} aria-label="직접 쓰기">
        <h2 className={s.boxTitle}>✍️ 직접 쓰기</h2>
        <p className={s.hint}>내 경험으로 만든 답변 조각을 적어요. 외운 틀을 넣으면 섬에서 강조돼요.</p>
        <textarea
          className={s.input}
          lang="en"
          value={en}
          maxLength={TOEIC_ISLAND_EN_MAX}
          placeholder="My go-to spot on weekends is a small park near my apartment."
          aria-label="영어 문장"
          onChange={(e) => setEn(e.target.value)}
        />
        <input
          className={s.input}
          type="text"
          value={ko}
          maxLength={TOEIC_ISLAND_KO_MAX}
          placeholder="한국어 메모(떠올릴 단서) — 예: 주말 단골 장소"
          aria-label="한국어 메모"
          onChange={(e) => setKo(e.target.value)}
        />
        <TopicChips topics={topics} value={topic} onChange={setTopic} />
        <div className={s.panelRow}>
          <button type="button" className="u-btn u-btn-primary" disabled={writeBusy} onClick={() => void submitWrite()}>
            {writeBusy ? "담는 중…" : `🏝️ ${TOEIC_ISLAND_PART_LABEL_KO[part]} 섬에 담기`}
          </button>
        </div>
        {writeMsg && (
          <p className={writeMsg.kind === "error" ? s.error : s.hint} role={writeMsg.kind === "error" ? "alert" : "status"}>
            {writeMsg.text}
          </p>
        )}
      </section>

      {total === 0 ? (
        <section className={s.box}>
          <p className={s.empty}>
            아직 {TOEIC_ISLAND_PART_LABEL_KO[part]} 섬이 비어 있어요. 🗣️ 틀 말하기 결과나 모의고사 첨삭에서 &ldquo;🏝️ 내 섬에 담기&rdquo;를 누르거나, 위에서 직접 써 보세요.
          </p>
        </section>
      ) : (
        groups.map((g) => (
          <section key={g.topicKey ?? "__none"} className={s.box} aria-label={g.nameKo} data-testid={`island-group-${g.topicKey ?? "none"}`}>
            <div className={s.groupHead}>
              <h2 className={s.boxTitle}>🏝️ {g.nameKo}</h2>
              <span className={s.count}>{g.entries.length}문장</span>
            </div>
            <ul className={s.list}>
              {g.entries.map((e) => (
                <li key={e.id} className={s.entry} data-testid={`island-entry-${e.id}`}>
                  {editId === e.id ? (
                    <>
                      <textarea className={s.input} lang="en" value={editEn} maxLength={TOEIC_ISLAND_EN_MAX} aria-label="영어 문장 고치기" onChange={(x) => setEditEn(x.target.value)} />
                      <input className={s.input} type="text" value={editKo} maxLength={TOEIC_ISLAND_KO_MAX} placeholder="한국어 메모" aria-label="한국어 메모 고치기" onChange={(x) => setEditKo(x.target.value)} />
                      <TopicChips topics={topics} value={editTopic} onChange={setEditTopic} />
                      <div className={s.tools}>
                        <button type="button" className="u-btn u-btn-primary" disabled={busyId === e.id} onClick={() => void saveEdit(e)}>
                          {busyId === e.id ? "저장 중…" : "저장"}
                        </button>
                        <button type="button" className="u-btn u-btn-secondary" disabled={busyId === e.id} onClick={() => setEditId(null)}>
                          취소
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={s.enRow}>
                        <p className={s.en} lang="en">
                          <Highlighted text={e.en} templates={templates} />
                        </p>
                        <button type="button" className={s.speakBtn} aria-label="섬 문장 듣기" onClick={() => speak(e.en, EN)}>
                          🔊
                        </button>
                      </div>
                      {e.ko && <p className={s.ko}>💬 {e.ko}</p>}
                      {e.spokenEn && (
                        <details className={s.spoken}>
                          <summary>내가 말한 문장</summary>
                          <span lang="en">{e.spokenEn}</span>
                        </details>
                      )}
                      {e.question && (
                        <details className={s.spoken}>
                          <summary>질문</summary>
                          <span lang="en">{e.question}</span>
                        </details>
                      )}
                      <p className={s.meta}>
                        {islandOriginLabelKo(e.origin)}
                        {e.createdAt ? ` · ${formatKst(e.createdAt)}` : ""}
                      </p>
                      <div className={s.tools}>
                        <button type="button" className={s.toolBtn} onClick={() => startEdit(e)}>
                          ✏️ 고치기
                        </button>
                        <button type="button" className={`${s.toolBtn} ${s.danger}`} onClick={() => setConfirmId(confirmId === e.id ? null : e.id)}>
                          🗑 지우기
                        </button>
                      </div>
                      {confirmId === e.id && (
                        <div className={s.confirm} role="alertdialog" aria-label="지우기 확인">
                          <span>이 문장을 섬에서 지울까요?</span>
                          <button type="button" className={`${s.toolBtn} ${s.danger}`} disabled={busyId === e.id} onClick={() => void remove(e)}>
                            {busyId === e.id ? "지우는 중…" : "지우기"}
                          </button>
                          <button type="button" className={s.toolBtn} onClick={() => setConfirmId(null)}>
                            취소
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {rowError?.id === e.id && (
                    <p className={s.error} role="alert">
                      {rowError.text}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
