import './styles.css';
import { registerPage } from './ui/registerPage';
import { processPage } from './ui/processPage';
import { listenPage } from './ui/listenPage';
import { archivePage } from './ui/archivePage';
import { toast } from './ui/widgets';

type Route = 'register' | 'process' | 'listen' | 'archive';

const TABS: Array<{ id: Route; label: string }> = [
  { id: 'register', label: '磁带登记' },
  { id: 'process', label: '修复处理' },
  { id: 'listen', label: '试听对比' },
  { id: 'archive', label: '归档' },
];

function currentRoute(): Route {
  const h = location.hash.replace('#/', '') as Route;
  return (['register', 'process', 'listen', 'archive'] as Route[]).includes(h) ? h : 'register';
}

function render() {
  const route = currentRoute();
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>磁带修复工作站</h1>
        <div class="sub">八十年代采访录音 · 抖晃校正 / 方位角估计 / 高频补偿</div>
      </div>
      <nav class="tabs">
        ${TABS.map((t) => `<button data-route="${t.id}" class="${t.id === route ? 'active' : ''}">${t.label}</button>`).join('')}
      </nav>
    </header>
    <main id="view"></main>
  `;
  app.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      location.hash = `#/${b.dataset.route}`;
    });
  });

  const view = document.getElementById('view')!;
  const mount = (node: HTMLElement) => view.appendChild(node);
  if (route === 'register') registerPage(mount);
  else if (route === 'process') processPage(mount);
  else if (route === 'listen') listenPage(mount);
  else archivePage(mount);
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  render();
  // 全局未捕获错误提示
  window.addEventListener('error', (e) => toast(e.message || '未知错误', true));
});
