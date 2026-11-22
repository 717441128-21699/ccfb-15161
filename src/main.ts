import { createApp } from './app/app';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载节点');
createApp(root);
