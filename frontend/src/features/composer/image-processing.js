let heicLoading
function loadHeic() {
  if (typeof window.heic2any === 'function') return Promise.resolve(window.heic2any)
  if (!heicLoading)
    heicLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/vendor/heic2any.min.js'
      script.onload = () =>
        typeof window.heic2any === 'function'
          ? resolve(window.heic2any)
          : reject(new Error('HEIC 解码库未正确加载'))
      script.onerror = () => reject(new Error('HEIC 解码库加载失败'))
      document.head.appendChild(script)
    }).catch((error) => {
      heicLoading = null
      throw error
    })
  return heicLoading
}
async function decode(file) {
  try {
    const image = await createImageBitmap(file)
    return { image, width: image.width, height: image.height, close: () => image.close() }
  } catch {
    const url = URL.createObjectURL(file),
      image = new Image()
    try {
      image.src = url
      await image.decode()
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片没有有效尺寸')
      return {
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      }
    } catch {
      URL.revokeObjectURL(url)
      throw new Error('图片无法解码，请重新选择原件或使用 JPEG/PNG')
    }
  }
}
async function jpeg(file, decoded, maxEdge = Infinity, quality = 0.9) {
  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height)),
    canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(decoded.width * scale))
  canvas.height = Math.max(1, Math.round(decoded.height * scale))
  canvas.getContext('2d').drawImage(decoded.image, 0, 0, canvas.width, canvas.height)
  try {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob?.size) throw new Error('图片转换失败，请使用 JPEG/PNG')
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
export async function prepareImage(original) {
  let file = original
  if (/image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    try {
      const decoded = await decode(file)
      try {
        file = await jpeg(file, decoded)
      } finally {
        decoded.close()
      }
    } catch {
      const convert = await loadHeic(),
        result = await convert({ blob: file, toType: 'image/jpeg', quality: 0.9 }),
        blob = Array.isArray(result) ? result[0] : result
      if (!blob?.size) throw new Error('HEIC 主图转换失败，请重新选择原件或使用 JPEG/PNG')
      file = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
    }
  }
  const decoded = await decode(file)
  try {
    const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)
    if (supported && (file.type === 'image/gif' || file.size < 300 * 1024)) return file
    const compressed = await jpeg(file, decoded, 1600, 0.85)
    return supported && compressed.size >= file.size ? file : compressed
  } finally {
    decoded.close()
  }
}
