import { Clapperboard, PencilLine } from 'lucide-react';
import { ms, type Scene, type Segment } from '../../shared/model';

export function PlaybackPanel({ scene, segment, playhead, onEdit }: { scene: Scene; segment: Segment | undefined; playhead: number; onEdit: () => void }) {
  const transition = segment?.kind === 'transition' ? scene.transitions[segment.id] : null;
  const title = transition ? `${scene.compositions[transition.fromId].name} → ${scene.compositions[transition.toId].name}` : segment ? scene.compositions[segment.id]?.name : scene.name;
  return <div className="inspector-content playback-panel">
    <div className="inspector-title"><span>Scene preview</span><span className="inspector-kind">{ms(playhead)} ms</span></div>
    <div className="property-section"><Clapperboard size={25} strokeWidth={1.4}/><h3>{title}</h3><p>再生位置の場面を開いて、配置や動きを編集できます。</p><button className="subtle-button full-width" onClick={onEdit}><PencilLine size={14}/>この場面を編集</button><span className="muted small">Esc で編集に戻る</span></div>
  </div>;
}
