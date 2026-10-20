// Web の picker だけが react-dom の createPortal を使う。型パッケージ(@types/react-dom)を増やさず、使う部分だけ宣言する。
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react';
  export function createPortal(children: ReactNode, container: Element): ReactPortal;
}
