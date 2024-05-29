export function getWindowInformation() {
  const width =
    window.innerWidth ||
    document.documentElement.clientWidth ||
    document.body.clientWidth;
  const height =
    window.innerHeight ||
    document.documentElement.clientHeight ||
    document.body.clientHeight;
  return {
    width,
    height,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
  };
}
