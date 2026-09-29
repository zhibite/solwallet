// Next.js 16 Turbopack 原生支持 ?react 后缀导入 SVG
declare module '*.svg?react' {
  import { FC, SVGProps } from 'react';
  const Icon: FC<SVGProps<SVGSVGElement>>;
  export default Icon;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
