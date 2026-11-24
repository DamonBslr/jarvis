// New-chat screen: what moved in your focus projects and what waits on you.
import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeOverview, OpenLoop } from '@shared/types'
import { timeAgo } from './knowledgeUi'

const api = window.jarvis

export function HomeDigest({ onAsk, onOpen }: { onAsk(prompt: string, cwd?: string): void; onOpen(): void }) {
  const [ov, setOv] = useState<KnowledgeOverview | null>(null)
  const load = useCallback(() => api.knowledge.overview().then(setOv), [])
  useEffect(() => {
    void load()
    return api.knowledge.onChanged(() => void load())
  }, [load])

  if (!ov || !ov.projects.length) return null
  const name = (id?: string) => ov.projects.find((d) => d.project.id === id)?.project.name
  const loops: OpenLoop[] = [...ov.projects.flatMap((d) => d.loops), ...ov.otherLoops]
    .sort((a, b) => (a.kind === 'review' ? 0 : 1) - (b.kind === 'review' ? 0 : 1) || b.at - a.at)
    .slice(0, 5)

  return (
    <div className="digest">
      <div className="digest-head">
        <span>
          {ov.lastSeenAt && ov.sinceLastSeen > 0
            ? `${ov.sinceLastSeen} updates in your projects since ${timeAgo(ov.lastSeenAt)}`
            : 'Your projects'}
        </span>
        <button
          className="link"
          onClick={() => {
            void api.knowledge.markSeen()
            onAsk("What did I miss? Go through my focus projects: what changed, what's waiting on me, and what I should do first today.")
          }}
        >
          Catch me up
        </button>
      </div>
      <div className="digest-projects">
        {ov.projects.map((d) => (
          <button
            key={d.project.id}
            className="digest-chip"
            title={`Ask about ${d.project.name}`}
            onClick={() => onAsk(`Catch me up on ${d.project.name}: where things stand, what's waiting on me, and what I should do next.`, d.project.path)}
          >
            {d.project.name}
            <span className="mem-meta">{d.counts.week} this week</span>
            {d.loops.length > 0 && <span className="loop-count">{d.loops.length}</span>}
          </button>
        ))}
      </div>
      {loops.length > 0 && (
        <div className="digest-loops">
          {loops.map((l) => (
            <div key={l.key} className="digest-loop">
              <span className={`loop-dot ${l.kind}`} />
              <span className="digest-loop-title">{l.title}</span>
              {name(l.projectId) && <span className="mem-meta">{name(l.projectId)}</span>}
            </div>
          ))}
        </div>
      )}
      <button className="link digest-all" onClick={onOpen}>
        All projects →
      </button>
    </div>
  )
}
