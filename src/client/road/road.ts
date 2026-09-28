import type { Material, StreamSignal } from '../../shared/haptics/signals';
import { UpscalerLink, loadForThermal } from '../../shared/upscaler/link';
import { HapticUpscaler } from '../../shared/upscaler/upscaler';
import { installClockSync, postNative, sendCommands } from '../haptics/nativeBridge';
import './road.css';

const SURFACES: Record<string, { label: string; material: Material; color: string }> = {
  asphalt: { label: '아스팔트', material: { hardness: 0.75, weight: 0.5, roughness: 0.1 }, color: '#697782' },
  gravel: { label: '자갈', material: { hardness: 0.6, weight: 0.4, roughness: 0.9 }, color: '#b69b73' },
  grass: { label: '잔디', material: { hardness: 0.2, weight: 0.3, roughness: 0.5 }, color: '#719364' },
};

type RoadWindow = Window & { __hsLoad?: (thermal: string) => void };

export const mountRoad = (): void => {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = `
    <main class="road-demo">
      <div class="road-top"><strong>HAPTIC STREAMLINE</strong><a id="road-exit" href="game.html">게임으로</a></div>
      <h1>노면 변화</h1>
      <p>같은 스트림 신호로 속도와 노면을 바꿔 아이폰 진동을 비교합니다.</p>
      <div class="road-window"><div class="road-sky"></div><div class="road-track"><div class="road-lines"></div></div><div class="road-car">▲</div></div>
      <div class="road-controls">
        <div id="road-surfaces" class="road-surfaces"></div>
        <label>속도 <input id="road-speed" type="range" min="20" max="100" value="60"><output id="road-speed-value">60%</output></label>
        <button id="road-drive" class="road-drive">주행 시작</button>
      </div>
      <p id="road-status" class="road-status"></p>
    </main>`;

  const hasDevice = installClockSync();
  const link = new UpscalerLink(new HapticUpscaler(), sendCommands);
  (window as RoadWindow).__hsLoad = (thermal) => link.load(loadForThermal(thermal));
  let surface = 'asphalt';
  let driving = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const speed = root.querySelector<HTMLInputElement>('#road-speed')!;
  const speedValue = root.querySelector<HTMLOutputElement>('#road-speed-value')!;
  const status = root.querySelector<HTMLElement>('#road-status')!;
  const drive = root.querySelector<HTMLButtonElement>('#road-drive')!;
  const track = root.querySelector<HTMLElement>('.road-track')!;
  const car = root.querySelector<HTMLElement>('.road-car')!;
  const surfaces = root.querySelector<HTMLElement>('#road-surfaces')!;

  const send = (phase: StreamSignal['phase']) => {
    const road = SURFACES[surface]!;
    const signal: StreamSignal = {
      kind: 'stream', id: 'road-surface', phase, t: performance.now(),
      value: phase === 'end' ? 0 : Number(speed.value) / 100,
      description: 'tyres roll over the ground',
      material: road.material, actor: 'self', target: 'world',
      valence: 'neutral', importance: 0.4,
    };
    link.signal(signal);
    postNative({ type: 'signal', signal, t1: performance.now() });
  };

  const render = () => {
    surfaces.replaceChildren();
    for (const [id, road] of Object.entries(SURFACES)) {
      const button = document.createElement('button');
      button.textContent = road.label;
      button.className = id === surface ? 'selected' : '';
      button.onclick = () => {
        surface = id;
        render();
        if (driving) send('update');
      };
      surfaces.append(button);
    }
    track.style.backgroundColor = SURFACES[surface]!.color;
    speedValue.value = `${speed.value}%`;
    status.textContent = `${SURFACES[surface]!.label} · ${speed.value}% · ${driving ? '주행 중' : '정지'}${hasDevice ? '' : ' · 진동은 iPhone 앱에서 재생'}`;
    drive.textContent = driving ? '주행 종료' : '주행 시작';
    car.classList.toggle('moving', driving);
  };

  speed.oninput = () => { render(); if (driving) send('update'); };
  drive.onclick = () => {
    driving = !driving;
    if (driving) {
      send('start');
      timer = setInterval(() => send('update'), 80);
    } else {
      if (timer) clearInterval(timer);
      timer = null;
      send('end');
    }
    render();
  };
  root.querySelector<HTMLAnchorElement>('#road-exit')!.onclick = (event) => {
    if (driving) send('end');
    if (timer) clearInterval(timer);
    if (postNative({ type: 'roadExit' })) event.preventDefault();
  };
  render();
};
