// 视频原地播放:点列表/相册里的视频封面,就在这个格子里用 ArtPlayer 播起来,不再为视频弹灯箱。
// 全屏、画中画、设置(倍速 / 画面比例)、键盘快捷键都由播放器提供,不自己造控件。
// 播放器:ArtPlayer 5.4.0(MIT,和 OpenList 用的是同一个),本地 vendor 在 /vendor/artplayer.min.js;
// 只开用得上的能力 —— 弹幕、字幕、hls/mpegts、截图、迷你窗、水印一律没有引。
// 依旧不自动播放:播放器在用户点击那一刻才创建,列表在此之前既没有播放器也不会去加载视频文件。
const PLAYER_URL = '/vendor/artplayer.min.js'
const FALLBACK_THEME = '#e5636f'

let active = null // { tile, container, art, collapse }
let loading = null

const playerCtor = () => globalThis.Artplayer || globalThis.window?.Artplayer || null

// 页面里出现视频格子就先把播放器脚本取回来:点击时 new ArtPlayer 是同步的,
// iOS 才认这是用户手势、允许带声音播放;真没取完时点了也不会丢,加载完接着播。
export function preloadInlineVideoPlayer() {
  if (playerCtor()) return Promise.resolve(playerCtor())
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = PLAYER_URL
      script.onload = () => resolve(playerCtor())
      script.onerror = () => { loading = null; reject(new Error('播放器脚本加载失败')) }
      document.head.appendChild(script)
    })
  }
  return loading
}

// 收起当前视频:销毁播放器并退回封面。destroy 会连 <video> 的 src 一起清掉,
// 否则元素虽然没了,浏览器还在后台把整个文件拉完。
export function stopInlineVideo() {
  if (!active) return
  const { tile, container, art, collapse } = active
  active = null
  try { art.destroy(true) } catch {}
  container.hidden = true
  if (collapse) collapse.hidden = true
  tile.style.aspectRatio = ''
  tile.classList.remove('is-playing')
}

// 多列格子里的小方块摆不下播放器控件:播放时让格子占满整行,并按画面比例铺开。
// 单列格子本来就够大,保持封面尺寸不动,免得竖版视频把帖子撑得老高。
function fitTileToRatio(tile, width, height) {
  if (tile.closest('.img-grid.n1') || !width || !height) return
  tile.style.aspectRatio = `${width} / ${height}`
}

function themeColor() {
  if (!globalThis.getComputedStyle) return FALLBACK_THEME
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || FALLBACK_THEME
}

function openPlayer(Ctor, tile, container, media, onError) {
  stopInlineVideo()
  const collapse = tile.querySelector('.media-collapse')
  // 先把格子撑开再建播放器:ArtPlayer 按容器量尺寸,撑开后再建才不会按小方块布局。
  // 封面帧和视频同分辨率,先按封面比例铺开,元数据到手再校正。
  const poster = tile.querySelector('img')
  if (poster?.naturalWidth) fitTileToRatio(tile, poster.naturalWidth, poster.naturalHeight)
  tile.classList.add('is-playing')
  container.hidden = false
  if (collapse) collapse.hidden = false
  Ctor.REMOVE_SRC_WHEN_DESTROY = true
  const art = new Ctor({
    container,
    url: media.url,
    poster: media.poster || '',
    lang: 'zh-cn',
    theme: themeColor(),
    autoplay: false, // 播放只由这一次点击触发
    autoSize: false, // 尺寸交给格子的 aspect-ratio,不让播放器自己改高度
    autoMini: false,
    flip: false,
    screenshot: false,
    fullscreenWeb: false,
    miniProgressBar: false,
    setting: true, // 设置面板:倍速 + 画面比例
    playbackRate: true,
    aspectRatio: true,
    pip: true, // 画中画;浏览器不支持时 ArtPlayer 自己降级
    fullscreen: true,
    hotkey: true,
    playsInline: true,
    moreVideoAttr: { 'webkit-playsinline': true, playsInline: true },
  })
  active = { tile, container, art, collapse }
  art.on('video:loadedmetadata', () => fitTileToRatio(tile, art.video?.videoWidth, art.video?.videoHeight))
  art.on('video:error', () => {
    // 切到下一个格子后才迟到的错误,不能把新的那个收掉
    if (active?.art !== art) return
    stopInlineVideo()
    onError?.()
  })
  // 编码不支持时由 video:error 收尾,这里只吃掉 Promise 的报错
  art.play()?.catch?.(() => {})
}

export function playInlineVideo(tile, media, { onError } = {}) {
  if (!media?.url || active?.tile === tile) return
  const container = tile.querySelector('.media-player')
  if (!container) return
  const Ctor = playerCtor()
  if (Ctor) {
    openPlayer(Ctor, tile, container, media, onError)
    return
  }
  // 刚进页面就点、脚本还在路上:到了以后再建;失败就把提示交回给界面
  void preloadInlineVideoPlayer().then((Loaded) => {
    if (!Loaded || active?.tile === tile) return
    openPlayer(Loaded, tile, container, media, onError)
  }).catch(() => onError?.())
}
