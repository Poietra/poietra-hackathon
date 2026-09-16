import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { PROPERTY_CHANNELS, PROPERTY_CHANNEL_LABELS, getPropertyTiming, hasPropertyTiming, type AnimationTiming, type AnimationTrack, type PropertyChannel, type SceneObject, type Transition } from '../../shared/model';
import { useEditor } from '../editor/context';
import { visibleAnimation } from '../editor/animation-tracks';
import { Field, NumberInput, Section } from './components';
import { EasingEditor } from './EasingEditor';
import './PropertyAnimation.css';

/** Keep imported settings reachable even when the current object/type does not use them. */
function channelsFor(object: SceneObject, track: AnimationTrack) {
  return PROPERTY_CHANNELS.filter(channel => {
    if (hasPropertyTiming(track, channel)) return true;
    if (channel === 'reveal') return track.type === 'write' || track.type === 'grow';
    if (channel === 'path') return object.kind === 'path';
    if (channel === 'fontSize') return object.kind === 'text' || object.kind === 'equation';
    if (channel === 'size') return object.kind !== 'text' && object.kind !== 'equation';
    if (channel === 'cornerRadius') return ['rectangle', 'image', 'video'].includes(object.kind);
    if (channel === 'fill') return !['image', 'video', 'path', 'arrow', 'numberline'].includes(object.kind);
    return true;
  });
}

export function PropertyTimingInspector({ object, transition, track }: { object: SceneObject; transition: Transition; track: AnimationTrack }) {
  const { scene, store, playing, viewingPlayback } = useEditor();
  const [chosen, setChosen] = useState<PropertyChannel>('position');
  const channels = channelsFor(object, track);
  const channel = channels.includes(chosen) ? chosen : channels[0];
  const timing = getPropertyTiming(track, channel);
  const independent = hasPropertyTiming(track, channel);
  const visible = !!visibleAnimation(scene, transition, object.id);
  const label = PROPERTY_CHANNEL_LABELS[channel];
  const [error, setError] = useState('');

  function apply(patch: Partial<AnimationTiming> | null, separate = true) {
    if (playing || viewingPlayback) return;
    try {
      const currentScene = store.scene(scene.id);
      const currentTransition = currentScene.transitions[transition.id];
      const current = currentTransition && visibleAnimation(currentScene, currentTransition, object.id);
      if (!current || current.object.locked) return;
      const previous = getPropertyTiming(current.track, channel);
      const next = patch === null ? null : { start: previous.start, duration: previous.duration, easing: previous.easing, ...patch };
      if (next) {
        next.start = Math.max(0, Math.min(next.start, currentTransition.duration));
        next.duration = Math.max(0, Math.min(next.duration, currentTransition.duration - next.start));
      }
      store.setPropertyTiming(scene.id, transition.id, object.id, channel, next, separate);
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '時間を変更できませんでした。'); }
  }

  return <Section title="Property timing">
    <div className="property-animation-inspector">
      <Field label="Property"><select aria-label="Animation property" value={channel} onChange={event => { setChosen(event.target.value as PropertyChannel); setError(''); }}>{channels.map(value => <option key={value} value={value}>{PROPERTY_CHANNEL_LABELS[value]}{hasPropertyTiming(track, value) ? ' · 個別' : ''}</option>)}</select></Field>
      <p className="property-timing-note">{independent ? 'この項目だけ、個別の時間で変化します。' : '共通の Timing を使用中。下の値を変えると、この項目だけ時間を分けられます。'}</p>
      <fieldset className="property-timing-fields" disabled={object.locked || playing || viewingPlayback || !visible}>
        <Field label="Start"><NumberInput key={`${channel}/start`} value={timing.start} onChange={start => apply({ start })} label={`${label} animation start`} suffix="ms" min={0} max={transition.duration}/></Field>
        <Field label="Duration"><NumberInput key={`${channel}/duration`} value={timing.duration} onChange={duration => apply({ duration })} label={`${label} animation duration`} suffix="ms" min={0} max={Math.max(0, transition.duration - timing.start)}/></Field>
        <EasingEditor key={`${scene.id}/${transition.id}/${object.id}/${channel}`} value={timing.easing} label={`${label} animation easing`} onChange={(easing, separate) => apply({ easing }, separate)} getValue={() => { const current = store.project().scenes[scene.id], latest = current?.transitions[transition.id]; const animation = latest && visibleAnimation(current, latest, object.id); return animation ? getPropertyTiming(animation.track, channel).easing : undefined; }} disabled={object.locked || playing || viewingPlayback || !visible || track.type === 'none'} disabledReason={track.type === 'none' ? 'Cut は瞬時に切り替わるため、イージングを使用しません。' : undefined}/>
        <button className="subtle-button full-width property-timing-reset" disabled={!independent} onClick={() => apply(null)}><RotateCcw size={13}/>共通の時間に戻す</button>
      </fieldset>
      {!visible && <p className="property-timing-note">いずれかの Composition で表示すると、動きを調整できます。</p>}
      {channel === 'reveal' && <p className="property-timing-note">Write の描画、Grow の拡大・縮小の進行を調整します。</p>}
      {channel === 'position' && <p className="property-timing-note">X・Y と移動パスの進行を一緒に調整します。</p>}
      {error && <p className="property-timing-error" role="alert">{error}</p>}
    </div>
  </Section>;
}
