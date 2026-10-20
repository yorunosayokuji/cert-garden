import { registerRootComponent } from 'expo';
import Root from './src/Root';
import { loadWebFont } from './src/ui/webFont';

loadWebFont(); // Webだけ同梱フォントを読み込む（native側は何もしない）

// 通常起動は本体。iOS候補の確認入口は src/Root.tsx の条件を満たす時だけ
registerRootComponent(Root);
