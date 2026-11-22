import { store } from './store';
import type { PageId } from './state';
import { renderRegisterPage } from './pages/register-page';
import { renderProcessPage } from './pages/process-page';
import { renderListenPage } from './pages/listen-page';
import { renderArchivePage } from './pages/archive-page';

const PAGE_TITLES: Record<PageId, { zh: string; en: string }> = {
  register: { zh: '磁带登记', en: 'Register' },
  process: { zh: '修复处理', en: 'Process' },
  listen: { zh: '试听对比', en: 'A/B Listen' },
  archive: { zh: '归档', en: 'Archive' },
};

const PAGE_ORDER: PageId[] = ['register', 'process', 'listen', 'archive'];

export function createApp(root: HTMLElement): void {
  store.subscribe(state => {
    root.innerHTML = '';
    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `<h1>磁带修复工作室<small>Tape Restoration Studio</small></h1>`;

    const nav = document.createElement('nav');
    nav.className = 'nav';
    for (const id of PAGE_ORDER) {
      const btn = document.createElement('button');
      btn.textContent = PAGE_TITLES[id].zh;
      if (id === state.page) btn.className = 'active';
      btn.onclick = () => store.setState({ page: id });
      nav.appendChild(btn);
    }
    header.appendChild(nav);

    const main = document.createElement('main');
    main.className = 'app-main';
    const renderers: Record<PageId, (el: HTMLElement) => void> = {
      register: renderRegisterPage,
      process: renderProcessPage,
      listen: renderListenPage,
      archive: renderArchivePage,
    };
    renderers[state.page](main);

    root.append(header, main);
  });
}
