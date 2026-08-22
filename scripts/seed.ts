/**
 * scripts/seed.ts — 로컬 데모 시드 (M1). 실행: `npm run seed`
 *
 * SPEC §12 픽스처 2권(Wolves, Pooh Gets Stuck)의 book과, 사람이 직접 창작한
 * 데모 카드 콘텐츠를 data/db.json에 주입한다. 목적: OPENAI_API_KEY 없이
 * /card/[id] 화면을 시각 검증·데모하기 위함.
 *
 * [데모 콘텐츠 주의]
 * - 아래 카드 콘텐츠는 AI 생성물이 아니라 이 스크립트에 하드코딩한 "데모용" 창작물이다.
 *   (데모 표시는 book.topic이 아니라 이 주석과 model 필드("seed-demo")로만 한다)
 * - 저작권 절대 원칙(SPEC §1) 준수: 책 본문 문장을 인용·복원하지 않았고,
 *   예문·질문·사실은 모두 일반 상식 수준에서 새로 작성했다.
 * - Card 스키마의 zod 검증(makeLearningCardSchema)을 통과해야만 저장한다 —
 *   실패 시 오류를 출력하고 exit 1.
 */

import { makeLearningCardSchema, type Card } from "../lib/ai/english/schemas";
import {
  mergeDbForSeed,
  type BookRecord,
  type CardRecord,
  type DbShape,
  type ReadingRecord,
} from "../lib/store";

// ---------------------------------------------------------------------------
// 책 1 — Wolves (논픽션, AR 3.3 → 단어 12·질문 8·funFacts 4)
// ---------------------------------------------------------------------------

const wolvesBook: BookRecord = {
  id: "seed-book-wolves",
  // SPEC §12 픽스처 원문 값
  title: "Wolves",
  author: "Laura Marsh",
  series: "National Geographic Kids Readers, Level 2",
  isbn: null,
  arLevel: 3.3,
  lexile: 570,
  wordCount: 864,
  arQuizNo: "148832",
  isFiction: false,
  topic: "늑대 — 무리(pack) 생활, 하울링, 사냥, 새끼 키우기",
  coverUrl: null,
  googleBooksId: null,
  coverEmoji: "🐺",
  description: null,
  levelEstimated: false,
  createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  // 근거 없이 만든 카드(storySource: "metadata") — 재생성해도 metadata 그대로다
  blurbText: null,
  sceneKind: null,
  sceneDigest: null,
};

const wolvesCard: Card = {
  bookIntroKo:
    "진짜 늑대 사진과 함께 늑대 가족의 하루, 사냥, 울음소리의 비밀을 만나는 자연 관찰 책이에요. 다 읽고 나면 친구들 앞에서 늑대 박사처럼 신나게 아는 척할 수 있어요.",
  levelNoteKo:
    "AR 3.3은 미국 3학년 세 번째 달 수준이라는 뜻이에요 — 정보책이라 단어가 조금 어렵지만 사진이 이해를 도와줘요.",
  // 논픽션 → 줄거리 대신 책이 다루는 내용을 순서대로 소개 (결말·세부 서술 없음, 직접 창작)
  storyOutlineKo:
    "늑대가 어떤 동물인지 사진과 함께 차근차근 알려주는 책이에요. 먼저 늑대 무리가 어떻게 가족을 이루어 사는지 보여주고, 이어서 사냥하는 법과 새끼 늑대가 자라는 모습을 소개해요. 그런데 늑대는 왜 밤마다 그렇게 길게 울까요? 그 비밀은 책에서 직접 확인해 보세요.",
  // 사진 근거 없이 제목·주제만으로 쓴 내용 소개 → metadata (배지 "예상"). 분량도 metadata 구간(3~4문장)
  storySource: "metadata",
  beforeReading: [
    {
      ko: "표지 탐정 놀이: 표지의 동물이 강아지인지 늑대인지 추리해 보세요. 어떻게 구별했는지 이유도 꼭 물어봐 주세요.",
    },
    {
      ko: "늑대 하면 떠오르는 것을 세 가지 말해 보기 — 다 읽고 나서 몇 개가 책에 나왔는지 확인하면 집중력이 살아나요.",
    },
  ],
  vocab: [
    {
      word: "wolf",
      pronKo: "울프",
      meaningKo: "늑대",
      easyEn: "a wild dog of the forest",
      exampleEn: "The gray wolf runs fast.",
      difficulty: "basic",
      isCore: true,
    },
    {
      word: "pack",
      pronKo: "팩",
      meaningKo: "늑대 무리",
      easyEn: "a wolf family group",
      exampleEn: "Wolves live in a pack.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "pup",
      pronKo: "펍",
      meaningKo: "새끼 늑대",
      easyEn: "a baby wolf",
      exampleEn: "The pup plays with leaves.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "den",
      pronKo: "덴",
      meaningKo: "굴, 보금자리",
      easyEn: "a wolf's home",
      exampleEn: "The den is warm inside.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "howl",
      pronKo: "하울",
      meaningKo: "길게 울다",
      easyEn: "a long wolf song",
      exampleEn: "Wolves howl at the moon.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "hunt",
      pronKo: "헌트",
      meaningKo: "사냥하다",
      easyEn: "to look for food",
      exampleEn: "The pack hunts at night.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "prey",
      pronKo: "프레이",
      meaningKo: "먹잇감",
      easyEn: "an animal that gets eaten",
      exampleEn: "A deer can be prey.",
      difficulty: "challenge",
      isCore: false,
    },
    {
      word: "predator",
      pronKo: "프레더터",
      meaningKo: "포식자",
      easyEn: "an animal that hunts others",
      exampleEn: "The predator waits very quietly.",
      difficulty: "challenge",
      isCore: false,
    },
    {
      word: "fur",
      pronKo: "퍼",
      meaningKo: "(동물의) 털",
      easyEn: "thick animal hair",
      exampleEn: "Soft fur keeps wolves warm.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "paw",
      pronKo: "포",
      meaningKo: "(동물의) 발",
      easyEn: "an animal's foot",
      exampleEn: "Each paw leaves a print.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "sniff",
      pronKo: "스니프",
      meaningKo: "킁킁 냄새 맡다",
      easyEn: "to smell something quickly",
      exampleEn: "Wolves sniff the cold air.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "wild",
      pronKo: "와일드",
      meaningKo: "야생의",
      easyEn: "living free in nature",
      exampleEn: "Wolves are wild, not pets.",
      difficulty: "basic",
      isCore: false,
    },
  ],
  teachingTipKo:
    "wolf 한 마리, wolves 여러 마리! f로 끝나는 단어는 복수형에서 -ves로 변신해요 (leaf→leaves, knife→knives). 제목이 왜 Wolves인지 아이가 스스로 발견하게 기다려 주세요.",
  whileReading: [
    { ko: "사진에서 den(굴)이나 pup(새끼)이 보이면 손가락으로 짚고 영어로 외쳐 보세요." },
    { ko: "howl이 나오면 함께 작게 '아우~' 하고 늑대 울음을 따라 해 보세요. (밤에는 속삭임 버전으로!)" },
    { ko: "모르는 단어가 나와도 멈추지 말고 포스트잇 한 장만 붙이고 지나가요 — 흐름이 먼저예요." },
  ],
  questions: [
    {
      type: "사실확인",
      en: "What do we call a wolf family?",
      ko: "늑대 가족을 영어로 뭐라고 부를까?",
      hintKo: "정답은 pack! 맞히면 'Nice! 우리 pack 최고!' 하고 하이파이브해 주세요.",
    },
    {
      type: "배경",
      en: "Where do wolf pups sleep?",
      ko: "새끼 늑대들은 어디에서 잠을 잘까?",
      hintKo: "정답은 den(굴)이에요. '우리 집은 우리 가족의 den이네!'로 이어가 보세요.",
    },
    {
      type: "인과",
      en: "Why do wolves howl at night?",
      ko: "늑대는 왜 밤에 길게 울까?",
      hintKo: "멀리 있는 가족을 부르는 늑대의 전화예요. because로 답하게 살짝 도와주세요.",
    },
    {
      type: "비교",
      en: "How are wolves and dogs different?",
      ko: "늑대랑 강아지는 무엇이 다를까?",
      hintKo: null,
    },
    {
      type: "예측",
      en: "What will the pack do in winter?",
      ko: "겨울이 오면 늑대 무리는 무엇을 할 것 같아?",
      hintKo: null,
    },
    {
      type: "상상",
      en: "If you were a wolf, where would you live?",
      ko: "네가 늑대라면 어디에서 살고 싶어?",
      hintKo: null,
    },
    {
      type: "내생각",
      en: "Are wolves scary or cool? Why?",
      ko: "늑대는 무서운 동물일까, 멋진 동물일까? 왜 그렇게 생각해?",
      hintKo: "정답이 없는 질문이에요. 아이 대답에 'Why?' 한 번만 더 물어봐 주세요.",
    },
    {
      type: "나와연결",
      en: "Our family is a pack too. Who leads our pack?",
      ko: "우리 가족도 하나의 pack이야. 우리 pack의 대장은 누구일까?",
      hintKo: null,
    },
  ],
  funFacts: [
    {
      en: "A wolf's howl can be heard from far away.",
      ko: "늑대 울음소리는 아주 멀리서도 들려요.",
    },
    {
      en: "Wolf pups are born with blue eyes.",
      ko: "새끼 늑대는 파란 눈으로 태어나요.",
    },
    {
      en: "Dogs came from wolves long, long ago.",
      ko: "아주 먼 옛날, 개는 늑대에서 나왔어요.",
    },
    {
      en: "A wolf pack is mostly one big family.",
      ko: "늑대 무리는 대부분 하나의 큰 가족이에요.",
    },
  ],
  activities: [
    {
      titleKo: "하울링 전화 놀이",
      descKo:
        "방 양 끝에 떨어져 서서 하울링으로 신호를 보내요. 긴 소리는 '배고파', 짧은 소리 두 번은 '놀자'처럼 가족만의 늑대 말을 정해 보세요.",
    },
    {
      titleKo: "늑대 vs 강아지 벤다이어그램",
      descKo:
        "종이에 원 두 개를 겹쳐 그리고 닮은 점은 가운데, 다른 점은 양쪽에 그림으로 채워요. 오늘 배운 단어를 하나라도 쓰면 성공!",
    },
  ],
};

// ---------------------------------------------------------------------------
// 책 2 — Pooh Gets Stuck (픽션, AR 2.0 → 단어 12·질문 8·funFacts null)
// ---------------------------------------------------------------------------

const poohBook: BookRecord = {
  id: "seed-book-pooh",
  // SPEC §12 픽스처 원문 값
  title: "Pooh Gets Stuck",
  author: "Isabel Gaines",
  series: "A Winnie the Pooh First Reader",
  isbn: null,
  arLevel: 2.0,
  lexile: 430,
  wordCount: 551,
  arQuizNo: "41866",
  isFiction: true,
  topic: "푸가 꿀을 너무 많이 먹고 토끼네 집 구멍에 끼는 소동",
  coverUrl: null,
  googleBooksId: null,
  coverEmoji: "🍯",
  description: null,
  levelEstimated: false,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  // 줄거리 근거 (SPEC §5) — 데모용. sceneDigest는 카드 선언 뒤에 복사한다(아래).
  blurbText:
    "꿀을 좋아하는 곰돌이 푸가 친구 집에서 벌인 소동을 담은 이야기. 첫 읽기 책 시리즈로, 짧은 문장과 큰 그림으로 되어 있어요.",
  sceneKind: "pages",
  sceneDigest: null,
};

const poohCard: Card = {
  bookIntroKo:
    "꿀을 사랑하는 곰돌이 푸가 토끼네 집에 놀러 갔다가 그만 구멍에 끼어 버려요. 친구들이 푸를 어떻게 구해 줄지 함께 응원하며 읽는 이야기예요.",
  levelNoteKo:
    "AR 2.0은 미국 2학년 첫 달 수준이라는 뜻이에요 — 문장이 짧아서 소리 내어 함께 읽기에 딱 좋아요.",
  // 픽션 → 큰 흐름만 담은 줄거리, 결말은 말하지 않고 마지막 문장으로 궁금증 유발 (직접 창작).
  // 아래 sceneDigest(장면 6개)를 근거로 삼은 카드이므로 그 장면 수에서 계산한 구간(5~8문장)으로 쓴다
  // — storyOutlineSentenceRange("pages", 6). 현재 7문장.
  storyOutlineKo:
    "꿀을 좋아하는 곰돌이 푸가 아침부터 배가 고파 친구 토끼네 집으로 향해요. 토끼는 반갑게 맞아 주면서 꿀단지를 꺼내 주죠. 푸는 한 단지로 멈추지 못하고 계속 꿀을 먹어요. 배가 빵빵해진 채 집으로 돌아가려는 순간, 문 구멍에 몸이 꽉 끼어 버려요. 토끼가 뒤에서 밀고 친구들이 앞에서 당겨 보지만 푸는 꼼짝도 하지 않아요. 결국 친구들은 다른 방법을 찾아보기로 해요. 푸는 과연 구멍에서 빠져나올 수 있을까요?",
  storySource: "pages", // 아래 sceneDigest(본문 장면 메모)를 근거로 삼았다는 표시 → 배지 "본문 확인"
  /**
   * 데모용 장면 메모 — 실제 사진 판독 결과가 아니라 손으로 쓴 시연 데이터다.
   * 내용은 SPEC §12 픽스처의 주제 한 줄 수준에 머무르고, 원문 전사는 없다.
   * 목적: API 키 없이도 sceneDigest UI·인쇄를 만들고 확인할 수 있게 하는 것.
   */
  sceneDigest: [
    {
      seq: 1,
      labelKo: "1~2쪽",
      summaryKo:
        "곰돌이 푸가 아침부터 배가 고파 집을 나서요. 어디로 갈지 벌써 정해 둔 얼굴이에요.",
      askKo: "푸는 지금 어디로 가는 길일까? 표정을 보고 맞혀 볼까?",
      confidence: "high",
      gapBefore: false,
    },
    {
      seq: 2,
      labelKo: "3~4쪽",
      summaryKo: "푸가 토끼네 집 앞에 도착해 문 구멍으로 인사를 건네요. 토끼는 반가워하면서도 살짝 걱정하는 표정이에요.",
      askKo: "토끼는 왜 웃으면서도 걱정하는 얼굴일까?",
      confidence: "high",
      gapBefore: false,
    },
    {
      seq: 3,
      labelKo: "5~6쪽",
      summaryKo: "토끼가 꺼내 준 꿀을 푸가 하나씩 비워 가요. 그림 속 꿀단지가 점점 줄어드는 게 보여요.",
      askKo: "꿀단지가 몇 개나 줄었는지 그림에서 세어 볼까?",
      confidence: "high",
      gapBefore: false,
    },
    {
      seq: 4,
      labelKo: "7~8쪽",
      summaryKo:
        "배가 빵빵해진 푸가 집에 가려고 문 구멍으로 몸을 밀어 넣어요. 앞발은 밖으로 나왔는데 몸이 더는 움직이지 않아요.",
      askKo: "푸의 몸이 왜 멈췄을까? 들어올 때와 무엇이 달라졌지?",
      confidence: "high",
      gapBefore: false,
    },
    {
      seq: 5,
      labelKo: "9~10쪽",
      summaryKo: "토끼가 뒤에서 밀고, 소식을 들은 친구들이 하나둘 모여들어요. 다 같이 당기고 밀어 보지만 푸는 꼼짝도 하지 않아요.",
      askKo: "너라면 푸를 어떻게 꺼내 줄 것 같아?",
      confidence: "medium",
      gapBefore: false,
    },
    {
      seq: 6,
      labelKo: "11~12쪽",
      summaryKo:
        "친구들은 푸가 다시 홀쭉해질 때까지 기다려 보기로 해요. 푸가 어떻게 나오게 되는지는 마지막 장에서 확인해요.",
      askKo: "푸는 기다리는 동안 무슨 생각을 하고 있을까?",
      confidence: "high",
      gapBefore: false,
    },
  ],
  beforeReading: [
    {
      ko: "표지 탐정 놀이: 표지에서 누가 누구를 당기고 있는지, 왜 이런 일이 벌어졌는지 그림만 보고 추리해 보세요.",
    },
    {
      ko: "제목의 stuck이 무슨 뜻일지 추측해 보기 — 정답은 알려주지 말고 '읽으면서 확인해 보자!'로 궁금증을 남겨 두세요.",
    },
  ],
  vocab: [
    {
      word: "stuck",
      pronKo: "스턱",
      meaningKo: "끼인, 못 움직이는",
      easyEn: "can't move at all",
      exampleEn: "Oh no, the bear is stuck!",
      difficulty: "basic",
      isCore: true,
    },
    {
      word: "honey",
      pronKo: "허니",
      meaningKo: "꿀",
      easyEn: "sweet food from bees",
      exampleEn: "Bears love sweet honey.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "pull",
      pronKo: "풀",
      meaningKo: "당기다",
      easyEn: "to move something to you",
      exampleEn: "Pull the rope hard!",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "push",
      pronKo: "푸시",
      meaningKo: "밀다",
      easyEn: "to move something away",
      exampleEn: "Please push the door open.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "squeeze",
      pronKo: "스퀴즈",
      meaningKo: "비집고 들어가다",
      easyEn: "to fit into a small space",
      exampleEn: "He squeezes through the gap.",
      difficulty: "challenge",
      isCore: false,
    },
    {
      word: "tight",
      pronKo: "타이트",
      meaningKo: "꽉 끼는",
      easyEn: "not loose at all",
      exampleEn: "The hole is too tight.",
      difficulty: "challenge",
      isCore: false,
    },
    {
      word: "hole",
      pronKo: "호울",
      meaningKo: "구멍",
      easyEn: "an open round space",
      exampleEn: "A rabbit lives in a hole.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "hungry",
      pronKo: "헝그리",
      meaningKo: "배고픈",
      easyEn: "wanting to eat food",
      exampleEn: "I am so hungry now.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "full",
      pronKo: "풀",
      meaningKo: "배부른",
      easyEn: "no more food, please",
      exampleEn: "My tummy is very full.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "visit",
      pronKo: "비지트",
      meaningKo: "놀러 가다",
      easyEn: "to go see a friend",
      exampleEn: "Let's visit our friend today.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "wait",
      pronKo: "웨이트",
      meaningKo: "기다리다",
      easyEn: "to stay until later",
      exampleEn: "We must wait a little.",
      difficulty: "basic",
      isCore: false,
    },
    {
      word: "tummy",
      pronKo: "터미",
      meaningKo: "배 (아이 말)",
      easyEn: "your belly",
      exampleEn: "What a round tummy!",
      difficulty: "basic",
      isCore: false,
    },
  ],
  teachingTipKo:
    "pull(당기다)과 full(배부른)은 소리가 비슷해요. 입술을 붙였다 떼는 p, 윗니를 아랫입술에 살짝 대는 f — 거울을 보며 번갈아 말해 보면 재미있는 발음 연습이 돼요.",
  whileReading: [
    { ko: "stuck이라는 단어가 들리면 두 팔을 몸에 딱 붙이고 'Stuck!' 하고 얼음이 되어 보세요." },
    { ko: "친구들이 푸를 당기는 장면에서는 다 같이 'Pull! Pull!' 응원 구호를 외쳐요." },
    { ko: "푸의 표정이 바뀔 때마다 똑같이 따라 해 보세요 — 표정으로 감정 단어를 자연스럽게 익혀요." },
  ],
  questions: [
    {
      type: "인물",
      en: "Who gets stuck in the hole?",
      ko: "구멍에 끼인 친구는 누구였지?",
      hintKo: "정답: 곰돌이 푸! 맞히면 'You got it!' 하고 꼭 안아 주세요.",
    },
    {
      type: "사건",
      en: "What happens at Rabbit's house?",
      ko: "토끼네 집에서 무슨 일이 일어났을까?",
      hintKo: null,
    },
    {
      type: "인과",
      en: "Why does Pooh get stuck?",
      ko: "푸는 왜 구멍에 끼었을까?",
      hintKo: "'너무 많이 먹어서'가 나오면 성공! because를 살짝 흘려 주세요.",
    },
    {
      type: "감정",
      en: "How does Pooh feel when he cannot move?",
      ko: "움직일 수 없을 때 푸는 기분이 어땠을까?",
      hintKo: null,
    },
    {
      type: "결말",
      en: "How does Pooh get out at the end?",
      ko: "마지막에 푸는 어떻게 빠져나왔을까?",
      hintKo: "친구들이 힘을 모아 도와줬어요. '함께라서 가능했네!'라고 정리해 주세요.",
    },
    {
      type: "상상",
      en: "What would you do to help Pooh?",
      ko: "네가 그 자리에 있었다면 푸를 어떻게 도와줄래?",
      hintKo: null,
    },
    {
      type: "예측",
      en: "What will Pooh eat next time?",
      ko: "다음번에 푸는 무엇을 얼마나 먹으면 좋을까?",
      hintKo: null,
    },
    {
      type: "나와연결",
      en: "Have you ever eaten too much yummy food?",
      ko: "너도 맛있는 걸 너무 많이 먹어 본 적 있어?",
      hintKo: "아이 경험이 나오면 '푸랑 똑같네!' 하고 웃으며 공감해 주세요.",
    },
  ],
  funFacts: null, // 픽션은 null (HARNESS §4)
  activities: [
    {
      titleKo: "인형 구출 놀이",
      descKo:
        "쿠션 사이에 인형을 끼워 두고 영어로만 구출 작전을 펼쳐요. 'Pull!', 'Push!', 'One, two, three!' 구출에 성공하면 다 함께 'You're out!'을 외쳐요.",
    },
    {
      titleKo: "헝그리·풀 게이지",
      descKo:
        "간식 시간에 배를 가리키며 hungry와 full 게이지 놀이를 해요. 'How's your tummy?' 'Half full!'처럼 오늘 배운 단어를 식탁으로 가져와요.",
    },
  ],
};

/*
 * 카드가 근거로 삼은 장면 메모를 book에도 복사한다 (SPEC §5).
 * 카드의 sceneDigest는 "만든 시점의 스냅샷", book의 sceneDigest는 "다시 생성용 원본"이다 —
 * 사진을 저장하지 않으므로 book 쪽이 사라지면 재생성이 근거를 잃고 줄거리가
 * 3~4문장 "예상"으로 퇴화한다(QA F7). 두 곳이 같은 데이터를 갖는 상태를 시드로 재현해
 * 키 없이도 재생성 입력 경로를 눈으로 확인할 수 있게 한다.
 */
poohBook.sceneDigest = poohCard.sceneDigest ?? null;

// ---------------------------------------------------------------------------
// 읽음 기록 (M3) — 서재의 요약·AR 추이 차트를 로컬 데모하기 위한 샘플.
// 날짜를 3주에 걸쳐 분산: Pooh(AR 2.0)를 먼저, Wolves(AR 3.3)를 나중에 읽은
// 흐름이라 차트에 레벨 상승 추이가 나타난다. readAt은 날짜만(YYYY-MM-DD) —
// /api/readings와 같은 규칙. '오늘' 기록은 일부러 비워 두어 카드 화면의
// "오늘 읽었어요" 데모가 가능하다.
// ---------------------------------------------------------------------------

/** n일 전 날짜 (YYYY-MM-DD) */
function daysAgoDate(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const seedReadings: ReadingRecord[] = [
  { id: "seed-reading-1", bookId: poohBook.id, readAt: daysAgoDate(24), rating: 4, noteKo: null },
  {
    id: "seed-reading-2",
    bookId: poohBook.id,
    readAt: daysAgoDate(20),
    rating: 5,
    noteKo: "혼자서 끝까지 소리 내어 읽었어요",
  },
  { id: "seed-reading-3", bookId: poohBook.id, readAt: daysAgoDate(15), rating: null, noteKo: null },
  { id: "seed-reading-4", bookId: wolvesBook.id, readAt: daysAgoDate(10), rating: 3, noteKo: null },
  { id: "seed-reading-5", bookId: wolvesBook.id, readAt: daysAgoDate(6), rating: 4, noteKo: null },
  {
    id: "seed-reading-6",
    bookId: wolvesBook.id,
    readAt: daysAgoDate(2),
    rating: 5,
    noteKo: "하울링 흉내를 내며 신나게 읽음",
  },
];

// ---------------------------------------------------------------------------
// 검증 → 주입
// ---------------------------------------------------------------------------

function validateOrExit(name: string, book: BookRecord, card: Card): void {
  const schema = makeLearningCardSchema({
    arLevel: book.arLevel,
    isFiction: book.isFiction,
    // 시드는 모델 출력이 아니라 손으로 쓴 데모 데이터다 — 근거 게이트는 카드가 스스로 밝힌
    // storySource를 그대로 인정하고, 개수·중복 같은 구조 규칙만 검사한다.
    allowedStorySource: card.storySource ?? "metadata",
  });
  const result = schema.safeParse(card);
  if (!result.success) {
    console.error(`❌ [${name}] 데모 카드가 zod 검증에 실패했습니다:`);
    for (const issue of result.error.issues) {
      console.error(`   - ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  console.log(`✓ [${name}] zod 검증 통과 (단어 ${card.vocab.length} · 질문 ${card.questions.length})`);
}

async function main() {
  validateOrExit("Wolves", wolvesBook, wolvesCard);
  validateOrExit("Pooh Gets Stuck", poohBook, poohCard);

  const now = new Date().toISOString();
  const cards: CardRecord[] = [
    {
      id: "seed-card-wolves",
      bookId: wolvesBook.id,
      content: wolvesCard,
      model: "seed-demo", // AI 생성이 아닌 데모 콘텐츠 표시
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    },
    {
      id: "seed-card-pooh",
      bookId: poohBook.id,
      content: poohCard,
      model: "seed-demo",
      createdAt: now,
    },
  ];

  const db: DbShape = {
    books: [wolvesBook, poohBook],
    cards,
    readings: seedReadings,
    // 수학 설명 기록(M4)은 시드가 만들지 않는다 — mergeDbForSeed가 id 기준 upsert라
    // 빈 배열을 넘겨도 기존 explanations는 그대로 남는다.
    explanations: [],
    // 단어장(영어 V1)도 같은 이유로 빈 배열 — DbShape가 요구하는 키라 빠뜨리면 tsc가 막는다.
    vocabBooks: [],
  };

  await mergeDbForSeed(db);

  console.log("\n✅ 시드 완료 — data/db.json을 통째로 교체했습니다.");
  console.log("   - Wolves(논픽션):        /card/seed-card-wolves");
  console.log("   - Pooh Gets Stuck(픽션): /card/seed-card-pooh");
  console.log(`   - 읽음 기록 ${seedReadings.length}개 (3주 분산) → /library 서재·AR 추이 차트 데모`);
  console.log("   `npm run dev` 후 위 경로에서 카드·서재 화면을 확인하세요.");
}

main().catch((err) => {
  console.error("시드 실패:", err);
  process.exit(1);
});
