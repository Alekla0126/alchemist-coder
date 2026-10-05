declare module '*?modulePath' {
  const path: string;
  export default path;
}

/** A file bundled with the main process (electron-vite): its path at run time. */
declare module '*?asset' {
  const path: string;
  export default path;
}
