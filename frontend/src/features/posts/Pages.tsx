import { Navigate, useParams } from 'react-router-dom'
import { useApp } from '../../app/AppProviders'
import { useResource } from '../../lib/use-resource'
import { monthKey, type Media, type Post } from '../../lib/types'
import { PostCard } from './PostCard'
import { MediaGrid } from '../../components/media/MediaGrid'
import { BackLink } from '../../components/layout/BackLink'
export function SinglePost() {
  const { id } = useParams(),
    { revision } = useApp()
  const { data, error, loading } = useResource<{ post: Post }>(`/api/posts/${id}`, revision)
  return (
    <>
      <BackLink to="/" label="时间轴" />
      {loading ? (
        <p role="status">正在读取…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        data && <PostCard key={`${id}-${revision}`} post={data.post} />
      )}
    </>
  )
}
export function Gallery() {
  const { site, revision } = useApp()
  if (site.privateMode && !site.user) return <Navigate to="/" replace />
  return <GalleryContent revision={revision} />
}
function GalleryContent({ revision }: { revision: number }) {
  const { data, error, loading } = useResource<{ images: Media[] }>('/api/gallery', revision)
  const groups = new Map<string, Media[]>()
  for (const item of data?.images || []) {
    const month = item.created_at ? monthKey(item.created_at) : '未知日期'
    groups.set(month, [...(groups.get(month) || []), item])
  }
  return (
    <>
      <div className="journal-heading">
        <div>
          <p className="eyebrow">OUR MOMENTS</p>
          <h1>相册</h1>
          <p>把闪光的瞬间留在这里。</p>
        </div>
      </div>
      {loading ? (
        <p role="status">正在读取…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : data?.images.length ? (
        <div className="gallery-page">
          {[...groups].map(([month, items]) => (
            <section className="gallery-month" key={month}>
              <h2 className="gallery-month-heading">
                <span>
                  {month === '未知日期' ? month : `${month.slice(0, 4)}年${Number(month.slice(5))}月`}
                </span>
                <span className="gallery-month-count">{items.length}</span>
              </h2>
              <MediaGrid items={items} gallery />
            </section>
          ))}
        </div>
      ) : (
        <p className="empty-tip">还没有照片，先记下一段日常吧。</p>
      )}
    </>
  )
}
