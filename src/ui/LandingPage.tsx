import { useId, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, AudioLines, Check, CornerDownRight, Link2, MessageSquare, MousePointer2, SlidersHorizontal } from 'lucide-react';
import type { Locale } from '../locale';
import { LANDING_COPY, type LandingCopy } from './landing-copy';
import './LandingPage.css';

export interface LandingPageProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onStart: (template: 'blank' | 'example') => void;
  busy: 'blank' | 'example' | null;
  error: string;
  onCancel: () => void;
  resumeUrl: string | null;
}

function MotionStudy({ copy }: { copy: LandingCopy }) {
  const [time, setTime] = useState(1000);
  const titleId = useId();
  const t = time / 2000, rest = 1 - t;
  const x = rest ** 3 * 72 + 3 * rest ** 2 * t * 240 + 3 * rest * t ** 2 * 300 + t ** 3 * 488;
  const y = rest ** 3 * 204 + 3 * rest ** 2 * t * 204 + 3 * rest * t ** 2 * 76 + t ** 3 * 76;
  const opacity = Math.min(1, time / 300);
  return <figure className="landing-motion-study">
    <div className="landing-study-heading"><span><SlidersHorizontal size={15}/>{copy.studyTitle}</span><span>{copy.studyLabel}</span></div>
    <svg viewBox="0 0 560 280" role="img" aria-labelledby={titleId}>
      <title id={titleId}>{copy.studyDescription}</title>
      <g className="landing-study-guides" fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M72 48V232 M176 48V232 M280 48V232 M384 48V232 M488 48V232 M48 76H512 M48 140H512 M48 204H512"/>
      </g>
      <path d="M72 204C240 204 300 76 488 76" fill="none" stroke="#67c4d9" strokeWidth="1.5" opacity="0.55"/>
      <circle cx="72" cy="204" r="17" fill="none" stroke="#737582" strokeDasharray="3 4"/>
      <circle cx="488" cy="76" r="17" fill="none" stroke="#737582" strokeDasharray="3 4"/>
      <text x="72" y="247" textAnchor="middle" className="landing-study-coordinate">{copy.studyFrom}</text>
      <text x="488" y="42" textAnchor="middle" className="landing-study-coordinate">{copy.studyTo}</text>
      <circle data-demo-object cx={x} cy={y} r="17" fill="#c8eef4" opacity={opacity}/>
      <g aria-hidden="true" transform={`translate(${x + 20} ${y + 20})`}>
        <path d="M0 0L4 15L8 10L14 9Z" fill="#67c4d9" stroke="#111217" strokeWidth="1.5"/>
        <rect x="13" y="12" width="42" height="21" rx="4" fill="#28434b"/>
        <text x="34" y="26" textAnchor="middle" fill="#c8eef4" fontSize="11">{copy.studyCursor}</text>
      </g>
    </svg>
    <div className="landing-study-timings" aria-label={copy.studyTimings}>
      <div><span><CornerDownRight size={12}/>{copy.studyPosition}</span><div className="landing-study-bar"><span style={{ width: '100%' }}/></div><span>{copy.studyPositionDuration}</span></div>
      <div><span><CornerDownRight size={12}/>{copy.studyOpacity}</span><div className="landing-study-bar"><span style={{ width: '15%' }}/></div><span>{copy.studyOpacityDuration}</span></div>
    </div>
    <div className="landing-study-control">
      <label htmlFor={`${titleId}-position`}>{copy.studyControl}</label>
      <output htmlFor={`${titleId}-position`}>{(time / 1000).toFixed(2)}<span>{copy.studyTotal}</span></output>
      <input id={`${titleId}-position`} type="range" min="0" max="2000" step="10" value={time} aria-label={copy.studyRange} aria-valuetext={`${(time / 1000).toFixed(2)} ${copy.seconds}`} onChange={event => setTime(Number(event.target.value))}/>
    </div>
  </figure>;
}

export function LandingPage({ locale, onLocaleChange, onStart, busy, error, onCancel, resumeUrl }: LandingPageProps) {
  const copy = LANDING_COPY[locale];
  return <div className="landing-page" id="top" lang={locale}>
    <a className="landing-skip" href="#landing-main">{copy.skip}</a>
    <header className="landing-header landing-container">
      <a className="landing-brand" href="#top" aria-label={copy.home}><img src="/poietra.svg" alt="" width="34" height="34"/><span>Poietra</span></a>
      <nav aria-label={copy.navigation}>
        <div className="landing-nav-links"><a href="#studio">{copy.studio}</a><a href="#features">{copy.features}</a><a href="#workflow">{copy.workflow}</a></div>
        <div className="landing-languages" role="group" aria-label={copy.language}>
          <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => onLocaleChange('en')}>English</button>
          <button type="button" lang="ja" aria-pressed={locale === 'ja'} onClick={() => onLocaleChange('ja')}>日本語</button>
        </div>
        <button className="landing-nav-start" disabled={!!busy} onClick={() => onStart('blank')}>{copy.start}<ArrowUpRight size={16}/></button>
      </nav>
    </header>

    <main id="landing-main" tabIndex={-1}>
      <section className="landing-hero landing-container" aria-labelledby="landing-title">
        <p className="landing-eyebrow"><span/>{copy.eyebrow}</p>
        <div className="landing-hero-layout">
          <h1 id="landing-title" lang="en">{copy.title[0]}<br/><span>{copy.title[1]}</span></h1>
          <div className="landing-hero-copy">
            <p className="landing-hero-statement">{copy.statement[0]}<br/>{copy.statement[1]}</p>
            <p>{copy.introduction}</p>
            <div className="landing-actions" aria-busy={!!busy}>
              <button className="landing-button landing-button-primary" disabled={!!busy} onClick={() => onStart('blank')}>{copy.newProject}<ArrowUpRight size={17}/></button>
              <button className="landing-button landing-button-secondary" disabled={!!busy} onClick={() => onStart('example')}>{copy.example}<ArrowRight size={16}/></button>
            </div>
            <p className="landing-start-note">{copy.accountNote}</p>
            {resumeUrl && <a className="landing-resume" href={resumeUrl}>{copy.resume}<ArrowRight size={14}/></a>}
            {busy && <div className="landing-launch-status"><p role="status">{busy === 'example' ? copy.preparingExample : copy.preparingProject}</p><button autoFocus onClick={onCancel}>{copy.cancel}</button></div>}
            {error && <p className="landing-launch-error" role="alert">{error}</p>}
          </div>
        </div>
        <div className="landing-hero-foot"><span>{copy.heroNote}</span><a href="#studio">{copy.seeStudio}<ArrowDown size={14}/></a></div>
      </section>

      <section className="landing-product landing-container" id="studio" aria-label={copy.editorLabel}>
        <figure>
          <div className="landing-product-frame"><img src="/studio-preview.png" alt={copy.editorAlt} width="1440" height="900" fetchPriority="high"/></div>
          <figcaption><span><span className="landing-caption-dot"/>Poietra Studio<span className="landing-caption-separator">/</span>{copy.editorCaption}</span><span>{copy.editorNote}</span></figcaption>
        </figure>
      </section>

      <section className="landing-detail landing-container" id="features" aria-labelledby="landing-detail-title">
        <div className="landing-section-copy">
          <p className="landing-section-index">01 <span>{copy.detailEyebrow}</span></p>
          <h2 id="landing-detail-title">{copy.detailTitle[0]}<br/>{copy.detailTitle[1]}</h2>
          <p>{copy.detailRhythm[0]}<br/>{copy.detailRhythm[1]}<br/>{copy.detailRhythm[2]}</p>
          <p className="landing-detail-description">{copy.detailDescription}</p>
          <a className="landing-inline-link" href="#workflow">{copy.detailLink}<ArrowRight size={16}/></a>
        </div>
        <MotionStudy copy={copy}/>
      </section>

      <section className="landing-workflow" id="workflow" aria-labelledby="landing-workflow-title">
        <div className="landing-container">
          <div className="landing-workflow-heading"><p className="landing-section-index">02 <span>{copy.workflowEyebrow}</span></p><h2 id="landing-workflow-title">{copy.workflowTitle[0]}<br/>{copy.workflowTitle[1]}</h2><p>{copy.workflowIntroduction[0]}<br/>{copy.workflowIntroduction[1]}</p></div>
          <ol className="landing-steps">
            <li>
              <div className="landing-step-number">01</div>
              <div className="landing-step-copy"><h3>{copy.sharingTitle}</h3><p>{copy.sharingDescription}</p></div>
              <div className="landing-step-aside"><Link2 size={19}/><span>{copy.sharingAside[0]}<br/>{' '}{copy.sharingAside[1]}</span></div>
            </li>
            <li>
              <div className="landing-step-number">02</div>
              <div className="landing-step-copy"><h3>{copy.aiTitle}</h3><p>{copy.aiBeforeMention}<code>@codex</code>{copy.aiAfterMention}</p></div>
              <div className="landing-ai-note" aria-label={copy.aiExampleLabel}><span><MessageSquare size={14}/>{copy.aiExampleEyebrow}</span><p><span>@codex</span> {copy.aiExample}</p><div><Check size={13}/>{copy.aiReview}</div></div>
            </li>
            <li>
              <div className="landing-step-number">03</div>
              <div className="landing-step-copy"><h3>{copy.mediaTitle}</h3><p>{copy.mediaDescription}</p></div>
              <div className="landing-step-aside"><AudioLines size={22}/><span>{copy.mediaAside[0]}<br/>{' '}{copy.mediaAside[1]}</span></div>
            </li>
          </ol>
        </div>
      </section>

      <section className="landing-closing landing-container" aria-labelledby="landing-closing-title">
        <div className="landing-closing-label"><MousePointer2 size={18}/><span>{copy.closingEyebrow}</span></div>
        <h2 id="landing-closing-title">{copy.closingTitle[0]}<br className="landing-mobile-break"/>{copy.closingTitle[1]}</h2>
        <button className="landing-button landing-button-primary" disabled={!!busy} onClick={() => { document.getElementById('landing-title')?.scrollIntoView({ block: 'start' }); onStart('blank'); }}>{copy.closingAction}<ArrowUpRight size={18}/></button>
        <p>{copy.closingNote}</p>
      </section>
    </main>

    <footer className="landing-footer landing-container"><a className="landing-brand" href="#top" aria-label={copy.backToTop}><img src="/poietra.svg" alt="" width="27" height="27"/><span>Poietra</span></a><p>{copy.footerNote}</p><a href="https://github.com/Poietra/poietra-hackathon" target="_blank" rel="noreferrer">GitHub<ArrowUpRight size={14}/></a></footer>
  </div>;
}
