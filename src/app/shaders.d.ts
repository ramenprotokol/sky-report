// GLSL files are bundled as text by esbuild (loader: text).
declare module '*.frag' {
  const source: string;
  export default source;
}
declare module '*.vert' {
  const source: string;
  export default source;
}
declare module '*.css';
