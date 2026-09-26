import {
  installClockSync,
  postNative,
  sendCommands,
} from '../haptics/nativeBridge';
import { LAB_BASE, LEAD, S1_TRIALS, type Trial } from './s1Trials';
import { S2_TRIALS } from './s2Trials';

const SESSIONS: Record<string, { title: string; trials: readonly Trial[] }> = {
  s1: { title: 'S1 · 재생기 확인', trials: S1_TRIALS },
  s2: { title: 'S2 · 부품과 세기 균형', trials: S2_TRIALS },
};

/**
 * Upscaler Lab page (game.html?lab=1). Runs the S1 session: automatic device
 * probes, then blind feel trials whose conditions are shuffled behind letter
 * labels. Results are saved as one JSON file with no device information.
 */

type LabWindow = Window & {
  __hsLabResult?: (probe: string, result: unknown) => void;
};

type SessionState = {
  probes: Record<string, unknown>;
  ratings: Map<string, Rating>;
  /** Shuffled variant order per trial, fixed for the session. */
  orders: Map<string, number[]>;
};

const STATE: Record<string, SessionState> = {};

type Rating = {
  trial: string;
  label: string;
  condition: string;
  answer: string;
  plays: number;
};

const PROBES = [
  'clock',
  'curvePoints',
  'eventsPerPattern',
  'players',
  'startLatency',
];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  style = ''
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (style) node.setAttribute('style', style);
  return node;
};

const button = (label: string, onClick: () => void, style = '') => {
  const b = el(
    'button',
    label,
    `font-size:15px;padding:8px 12px;margin:4px;border-radius:8px;border:1px solid #777;background:#2a2620;color:#f3ead8;${style}`
  );
  b.addEventListener('click', onClick);
  return b;
};

const shuffled = <T>(items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

export const mountLab = (session = 's1'): void => {
  const current = SESSIONS[session] ?? SESSIONS.s1!;
  const sessionId = SESSIONS[session] ? session : 's1';
  const inApp = installClockSync();
  // Answers survive switching sessions (and switching back) until saved.
  const state = (STATE[sessionId] ??= {
    probes: {},
    ratings: new Map(),
    orders: new Map(),
  });
  const { probes, ratings } = state;
  let voiceSeq = 0;

  document.body.innerHTML = '';
  document.body.setAttribute(
    'style',
    'margin:0;padding:12px 16px 40px;background:#141008;color:#f3ead8;font-family:system-ui,sans-serif;overflow-y:auto;height:auto'
  );
  const root = el('div', '', 'max-width:900px;margin:0 auto');
  document.body.append(root);

  root.append(el('h2', `업스케일 Lab · ${current.title}`, 'margin:4px 0'));
  const switcher = el('div');
  for (const [id, s] of Object.entries(SESSIONS))
    switcher.append(
      button(
        s.title,
        () => {
          if (id !== sessionId) mountLab(id);
        },
        id === sessionId ? 'background:#4a3a1c' : ''
      )
    );
  root.append(switcher);
  root.append(
    el(
      'p',
      inApp
        ? '각 시험의 A, B, C… 버튼을 눌러 진동을 느낀 뒤, 그 아래에서 답을 고르세요. 여러 번 눌러도 됩니다. 다 끝나면 맨 아래 "결과 저장"을 누르세요.'
        : '브라우저에서는 진동이 나지 않습니다. 앱 안에서 여세요.',
      'color:#cdbf9f;line-height:1.5'
    )
  );

  const toolbar = el('div');
  root.append(toolbar);

  // --- Automatic probes ---------------------------------------------------
  const probeStatus = el('span', '', 'color:#cdbf9f');
  toolbar.append(
    button('자동 측정', () => {
      let i = 0;
      const next = () => {
        const name = PROBES[i];
        if (!name) {
          probeStatus.textContent = ' 측정 완료';
          return;
        }
        probeStatus.textContent = ` 측정 중… (${i + 1}/${PROBES.length})`;
        postNative({ type: 'labProbe', probe: name });
      };
      (window as LabWindow).__hsLabResult = (probe, result) => {
        probes[probe] = result;
        i += 1;
        setTimeout(next, 200);
      };
      next();
    }),
    probeStatus
  );

  // --- Feel trials --------------------------------------------------------
  const play = (trial: Trial, variantIndex: number) => {
    const variant = trial.variants[variantIndex];
    if (!variant) return;
    postNative({
      type: 'labSet',
      reviseFadeMs: variant.settings?.reviseFadeMs ?? 8,
      holdLoopSeconds: variant.settings?.holdLoopSeconds ?? 30,
    });
    voiceSeq += 1;
    sendCommands(variant.commands(performance.now() + LEAD, `lab-${voiceSeq}`));
  };

  for (const trial of current.trials) {
    const box = el(
      'section',
      '',
      'border:1px solid #4a4234;border-radius:10px;padding:8px 12px;margin:12px 0'
    );
    box.append(el('h3', trial.title, 'margin:4px 0'));
    box.append(el('p', trial.question, 'margin:4px 0;color:#cdbf9f'));
    const order =
      state.orders.get(trial.id) ?? shuffled(trial.variants.map((_, i) => i));
    state.orders.set(trial.id, order);
    order.forEach((variantIndex, position) => {
      const label = String.fromCharCode(65 + position);
      const key = `${trial.id}/${label}`;
      const row = el('div', '', 'margin:6px 0');
      const answerButtons: HTMLButtonElement[] = [];
      const playButton = button(
        `${label} 재생`,
        () => {
          play(trial, variantIndex);
          const r = ratings.get(key);
          if (r) r.plays += 1;
          else
            ratings.set(key, {
              trial: trial.id,
              label,
              condition: trial.variants[variantIndex]!.condition,
              answer: '',
              plays: 1,
            });
        },
        'background:#4a3a1c'
      );
      row.append(playButton);
      for (const answer of trial.answers) {
        const b = button(answer, () => {
          const r = ratings.get(key);
          if (!r) return;
          r.answer = answer;
          for (const other of answerButtons) other.style.outline = '';
          b.style.outline = '2px solid #ffd75e';
        });
        if (ratings.get(key)?.answer === answer)
          b.style.outline = '2px solid #ffd75e';
        answerButtons.push(b);
        row.append(b);
      }
      box.append(row);
    });
    root.append(box);
  }

  // --- Save / exit --------------------------------------------------------
  const footer = el('div', '', 'margin-top:16px');
  const saveStatus = el('span', '', 'color:#cdbf9f');
  footer.append(
    button(
      '결과 저장',
      () => {
        const answered = [...ratings.values()].filter((r) => r.answer);
        const json = JSON.stringify(
          { session: sessionId, version: 1, probes, ratings: answered },
          null,
          2
        );
        const ok = postNative({ type: 'labSave', name: sessionId, json });
        saveStatus.textContent = ok
          ? ` 저장함 (답 ${answered.length}개)`
          : ' 앱 안에서만 저장됩니다';
      },
      'background:#1f4a2a'
    ),
    button('게임으로', () => {
      postNative({ type: 'labExit' });
    }),
    saveStatus
  );
  root.append(footer);

  if (inApp) sendCommands([{ op: 'defineBase', base: LAB_BASE }]);
};
