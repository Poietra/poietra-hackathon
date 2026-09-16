import { useId, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, AudioLines, Check, CornerDownRight, Link2, MessageSquare, MousePointer2, SlidersHorizontal } from 'lucide-react';
import './LandingPage.css';

export interface LandingPageProps {
  onStart: (template: 'blank' | 'example') => void;
  busy: 'blank' | 'example' | null;
  error: string;
  onCancel: () => void;
  resumeUrl: string | null;
}

function MotionStudy() {
  const [time, setTime] = useState(1000);
  const titleId = useId();
  const t = time / 2000, rest = 1 - t;
  const x = rest ** 3 * 72 + 3 * rest ** 2 * t * 240 + 3 * rest * t ** 2 * 300 + t ** 3 * 488;
  const y = rest ** 3 * 204 + 3 * rest ** 2 * t * 204 + 3 * rest * t ** 2 * 76 + t ** 3 * 76;
  const opacity = Math.min(1, time / 300);
  return <figure className="landing-motion-study">
    <div className="landing-study-heading"><span><SlidersHorizontal size={15}/>A study in motion</span><span>動きのデモ</span></div>
    <svg viewBox="0 0 560 280" role="img" aria-labelledby={titleId}>
      <title id={titleId}>位置は2秒、不透明度は0.3秒で変化する円。下のスライダーで再生位置を操作できます。</title>
      <g className="landing-study-guides" fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M72 48V232 M176 48V232 M280 48V232 M384 48V232 M488 48V232 M48 76H512 M48 140H512 M48 204H512"/>
      </g>
      <path d="M72 204C240 204 300 76 488 76" fill="none" stroke="#67c4d9" strokeWidth="1.5" opacity="0.55"/>
      <circle cx="72" cy="204" r="17" fill="none" stroke="#737582" strokeDasharray="3 4"/>
      <circle cx="488" cy="76" r="17" fill="none" stroke="#737582" strokeDasharray="3 4"/>
      <text x="72" y="247" textAnchor="middle" className="landing-study-coordinate">From</text>
      <text x="488" y="42" textAnchor="middle" className="landing-study-coordinate">To</text>
      <circle data-demo-object cx={x} cy={y} r="17" fill="#c8eef4" opacity={opacity}/>
      <g aria-hidden="true" transform={`translate(${x + 20} ${y + 20})`}>
        <path d="M0 0L4 15L8 10L14 9Z" fill="#67c4d9" stroke="#111217" strokeWidth="1.5"/>
        <rect x="13" y="12" width="42" height="21" rx="4" fill="#28434b"/>
        <text x="34" y="26" textAnchor="middle" fill="#c8eef4" fontSize="11">You</text>
      </g>
    </svg>
    <div className="landing-study-timings" aria-label="デモの時間設定">
      <div><span><CornerDownRight size={12}/>Position</span><div className="landing-study-bar"><span style={{ width: '100%' }}/></div><span>2.0 s</span></div>
      <div><span><CornerDownRight size={12}/>Opacity</span><div className="landing-study-bar"><span style={{ width: '15%' }}/></div><span>0.3 s</span></div>
    </div>
    <div className="landing-study-control">
      <label htmlFor={`${titleId}-position`}>ドラッグして、動きを確かめる</label>
      <output htmlFor={`${titleId}-position`}>{(time / 1000).toFixed(2)}<span> / 2.00 s</span></output>
      <input id={`${titleId}-position`} type="range" min="0" max="2000" step="10" value={time} aria-label="動きのデモの再生位置" aria-valuetext={`${(time / 1000).toFixed(2)} 秒`} onChange={event => setTime(Number(event.target.value))}/>
    </div>
  </figure>;
}

export function LandingPage({ onStart, busy, error, onCancel, resumeUrl }: LandingPageProps) {
  return <div className="landing-page" id="top">
    <a className="landing-skip" href="#landing-main">本文へ移動</a>
    <header className="landing-header landing-container">
      <a className="landing-brand" href="#top" aria-label="Poietra ホーム"><img src="/poietra.svg" alt="" width="34" height="34"/><span>Poietra</span></a>
      <nav aria-label="メインナビゲーション">
        <div className="landing-nav-links"><a href="#studio">Studio</a><a href="#features">できること</a><a href="#workflow">つくり方</a></div>
        <button className="landing-nav-start" disabled={!!busy} onClick={() => onStart('blank')}>制作をはじめる<ArrowUpRight size={16}/></button>
      </nav>
    </header>

    <main id="landing-main" tabIndex={-1}>
      <section className="landing-hero landing-container" aria-labelledby="landing-title">
        <p className="landing-eyebrow"><span/>The collaborative motion studio</p>
        <div className="landing-hero-layout">
          <h1 id="landing-title">Motion,<br/><span>together.</span></h1>
          <div className="landing-hero-copy">
            <p className="landing-hero-statement">ひとりのアイデアを、<br/>みんなの表現に。</p>
            <p>友人と同じキャンバスを開いて、文字も、図形も、動画も。AI と相談しながら、細部まで自分たちでつくる。</p>
            <div className="landing-actions" aria-busy={!!busy}>
              <button className="landing-button landing-button-primary" disabled={!!busy} onClick={() => onStart('blank')}>新しいプロジェクト<ArrowUpRight size={17}/></button>
              <button className="landing-button landing-button-secondary" disabled={!!busy} onClick={() => onStart('example')}>サンプルを編集<ArrowRight size={16}/></button>
            </div>
            <p className="landing-start-note">アカウントなしで、制作・共有を始められます。</p>
            {resumeUrl && <a className="landing-resume" href={resumeUrl}>前のプロジェクトを開く<ArrowRight size={14}/></a>}
            {busy && <div className="landing-launch-status"><p role="status">{busy === 'example' ? 'サンプルを準備しています…' : '新しいプロジェクトを準備しています…'}</p><button autoFocus onClick={onCancel}>キャンセル</button></div>}
            {error && <p className="landing-launch-error" role="alert">{error}</p>}
          </div>
        </div>
        <div className="landing-hero-foot"><span>Make room for your ideas.</span><a href="#studio">スタジオを見る<ArrowDown size={14}/></a></div>
      </section>

      <section className="landing-product landing-container" id="studio" aria-label="Poietra の編集画面">
        <figure>
          <div className="landing-product-frame"><img src="/studio-preview.png" alt="Poietra の実際の編集画面。微分と連鎖律を表す色付きの図形と数式を、レイヤー、プロパティ、タイムラインで編集しています。" width="1440" height="900" fetchPriority="high"/></div>
          <figcaption><span><span className="landing-caption-dot"/>Poietra Studio<span className="landing-caption-separator">/</span>制作例：微分と連鎖律</span><span>One canvas. Many possibilities.</span></figcaption>
        </figure>
      </section>

      <section className="landing-detail landing-container" id="features" aria-labelledby="landing-detail-title">
        <div className="landing-section-copy">
          <p className="landing-section-index">01 <span>Made to be edited</span></p>
          <h2 id="landing-detail-title">その動きに、<br/>あなたの意図を。</h2>
          <p>位置はゆっくり2秒。<br/>不透明度は、一瞬の0.3秒。<br/>ひとつのオブジェクトにも、別々のリズムを。</p>
          <p className="landing-detail-description">配置を決めたら、場面の間に動きをつける。ベジェ曲線で軌道を描き、開始時刻や長さを調整できます。文字も数式も、あとから一つずつ編集できます。</p>
          <a className="landing-inline-link" href="#workflow">アイデアを動きにするまで<ArrowRight size={16}/></a>
        </div>
        <MotionStudy/>
      </section>

      <section className="landing-workflow" id="workflow" aria-labelledby="landing-workflow-title">
        <div className="landing-container">
          <div className="landing-workflow-heading"><p className="landing-section-index">02 <span>A shared creative space</span></p><h2 id="landing-workflow-title">つくる時間を、<br/>一緒に。</h2><p>ファイルを送り合う代わりに、<br/>同じ場所で、次のアイデアへ。</p></div>
          <ol className="landing-steps">
            <li>
              <div className="landing-step-number">01</div>
              <div className="landing-step-copy"><h3>リンクひとつで、同じキャンバス。</h3><p>共有 URL を送れば、別の PC からもそのまま参加。友人の編集を見ながら、文字を直したり、図形を動かしたり。ログインなしでも、一緒に作業できます。</p></div>
              <div className="landing-step-aside"><Link2 size={19}/><span>Share a link.<br/>Start creating.</span></div>
            </li>
            <li>
              <div className="landing-step-number">02</div>
              <div className="landing-step-copy"><h3>AI も、制作の輪の中に。</h3><p>チャットで <code>@codex</code> に相談すると、今のプロジェクトに合わせた編集案が届きます。内容を確認して適用。そのあとも、手で細かく整えられます。</p></div>
              <div className="landing-ai-note" aria-label="AI への依頼例"><span><MessageSquare size={14}/>たとえば、こんな相談</span><p><span>@codex</span> 円を2秒かけて右へ動かして。文字は少し遅れて表示したい。</p><div><Check size={13}/>編集案を確認してから適用</div></div>
            </li>
            <li>
              <div className="landing-step-number">03</div>
              <div className="landing-step-copy"><h3>音も映像も、ひとつの作品に。</h3><p>画像・動画をキャンバスへ、音声は独立したトラックへ。タイミングをそろえ、作品全体をプレビュー。仕上がったら MP4・WebM に書き出せます。</p></div>
              <div className="landing-step-aside"><AudioLines size={22}/><span>Images. Video. Audio.<br/>Your composition.</span></div>
            </li>
          </ol>
        </div>
      </section>

      <section className="landing-closing landing-container" aria-labelledby="landing-closing-title">
        <div className="landing-closing-label"><MousePointer2 size={18}/><span>Your next idea starts here.</span></div>
        <h2 id="landing-closing-title">まずは、<br className="landing-mobile-break"/>ひとつ動かしてみる。</h2>
        <button className="landing-button landing-button-primary" disabled={!!busy} onClick={() => { document.getElementById('landing-title')?.scrollIntoView({ block: 'start' }); onStart('blank'); }}>空のキャンバスから始める<ArrowUpRight size={18}/></button>
        <p>ひとりで始めて、途中から一緒に。</p>
      </section>
    </main>

    <footer className="landing-footer landing-container"><a className="landing-brand" href="#top" aria-label="Poietra ページの先頭へ"><img src="/poietra.svg" alt="" width="27" height="27"/><span>Poietra</span></a><p>Motion, together.</p><a href="https://github.com/Poietra/poietra-hackathon" target="_blank" rel="noreferrer">GitHub<ArrowUpRight size={14}/></a></footer>
  </div>;
}
