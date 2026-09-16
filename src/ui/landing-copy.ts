import type { Locale } from '../locale';

export interface LandingCopy {
  skip: string;
  home: string;
  navigation: string;
  studio: string;
  features: string;
  workflow: string;
  start: string;
  eyebrow: string;
  title: readonly [string, string];
  statement: readonly [string, string];
  introduction: string;
  newProject: string;
  example: string;
  accountNote: string;
  resume: string;
  preparingExample: string;
  preparingProject: string;
  cancel: string;
  heroNote: string;
  seeStudio: string;
  editorLabel: string;
  editorAlt: string;
  editorCaption: string;
  editorNote: string;
  detailEyebrow: string;
  detailTitle: readonly [string, string];
  detailRhythm: readonly [string, string, string];
  detailDescription: string;
  detailLink: string;
  studyTitle: string;
  studyLabel: string;
  studyDescription: string;
  studyFrom: string;
  studyTo: string;
  studyCursor: string;
  studyTimings: string;
  studyPosition: string;
  studyOpacity: string;
  studyPositionDuration: string;
  studyOpacityDuration: string;
  studyControl: string;
  studyRange: string;
  studyTotal: string;
  seconds: string;
  workflowEyebrow: string;
  workflowTitle: readonly [string, string];
  workflowIntroduction: readonly [string, string];
  sharingTitle: string;
  sharingDescription: string;
  sharingAside: readonly [string, string];
  aiTitle: string;
  aiBeforeMention: string;
  aiAfterMention: string;
  aiExampleLabel: string;
  aiExampleEyebrow: string;
  aiExample: string;
  aiReview: string;
  mediaTitle: string;
  mediaDescription: string;
  mediaAside: readonly [string, string];
  closingEyebrow: string;
  closingTitle: readonly [string, string];
  closingAction: string;
  closingNote: string;
  backToTop: string;
  footerNote: string;
}

export const LANDING_COPY: Record<Locale, LandingCopy> = {
  en: {
    skip: 'Skip to content',
    home: 'Poietra home',
    navigation: 'Main navigation',
    studio: 'Studio',
    features: 'Features',
    workflow: 'How it works',
    start: 'Start creating',
    eyebrow: 'The collaborative motion studio',
    title: ['Motion,', 'together.'],
    statement: ['Your idea.', 'Our next creation.'],
    introduction: 'Bring text, shapes, and video to a shared canvas. Create with friends and AI, with every detail in your hands.',
    newProject: 'New project',
    example: 'Edit the example',
    accountNote: 'Start creating and sharing. No account needed.',
    resume: 'Open previous project',
    preparingExample: 'Preparing the example…',
    preparingProject: 'Preparing your new project…',
    cancel: 'Cancel',
    heroNote: 'Make room for your ideas.',
    seeStudio: 'Explore the studio',
    editorLabel: 'The Poietra editor',
    editorAlt: 'The Poietra editor showing a calculus animation: colored shapes and equations illustrate derivatives and the chain rule, alongside layers, properties, and a timeline.',
    editorCaption: 'Made in Poietra: the chain rule',
    editorNote: 'One canvas. Many possibilities.',
    detailEyebrow: 'Made to be edited',
    detailTitle: ['Every move,', 'just as you imagined.'],
    detailRhythm: ['Move over two seconds.', 'Fade in over just 0.3.', 'One object. A rhythm for every property.'],
    detailDescription: 'Set the scene, then bring it to life. Draw a Bézier motion path and fine-tune when each change begins and how long it takes. Every piece of text and every equation stays editable.',
    detailLink: 'From an idea to motion',
    studyTitle: 'A study in motion',
    studyLabel: 'Interactive demo',
    studyDescription: 'A circle moves over two seconds and fades in over 0.3 seconds. Use the slider below to explore the motion.',
    studyFrom: 'From',
    studyTo: 'To',
    studyCursor: 'You',
    studyTimings: 'Demo timing settings',
    studyPosition: 'Position',
    studyOpacity: 'Opacity',
    studyPositionDuration: '2.0 s',
    studyOpacityDuration: '0.3 s',
    studyControl: 'Drag to explore the motion',
    studyRange: 'Motion demo playback position',
    studyTotal: ' / 2.00 s',
    seconds: 'seconds',
    workflowEyebrow: 'A shared creative space',
    workflowTitle: ['Better ideas,', 'made together.'],
    workflowIntroduction: ['A shared space for your next idea.', 'No passing project files back and forth.'],
    sharingTitle: 'One link. The same canvas.',
    sharingDescription: 'Share a link and invite a friend to join from another computer. Edit text, move shapes, and see each other’s changes as you work. You can collaborate without signing in.',
    sharingAside: ['Share a link.', 'Start creating.'],
    aiTitle: 'Make room for an AI collaborator.',
    aiBeforeMention: 'Ask ',
    aiAfterMention: ' in the chat for edits that fit your project. Review the proposal, apply it, then refine every detail yourself.',
    aiExampleLabel: 'Example request to the AI assistant',
    aiExampleEyebrow: 'Something you could ask',
    aiExample: 'Move the circle to the right over two seconds. Bring the text in a little later.',
    aiReview: 'Review the edits before applying',
    mediaTitle: 'Picture, sound, and motion. Together.',
    mediaDescription: 'Add images and video to the canvas, and audio to its own track. Line up the timing and preview the whole project. When it’s ready, export to MP4 or WebM.',
    mediaAside: ['Images. Video. Audio.', 'Your composition.'],
    closingEyebrow: 'Your next idea starts here.',
    closingTitle: ['Start with', ' a little motion.'],
    closingAction: 'Start with a blank canvas',
    closingNote: 'Start on your own. Invite others along the way.',
    backToTop: 'Poietra back to top',
    footerNote: 'Motion, together.',
  },
  ja: {
    skip: '本文へ移動',
    home: 'Poietra ホーム',
    navigation: 'メインナビゲーション',
    studio: 'Studio',
    features: 'できること',
    workflow: 'つくり方',
    start: '制作をはじめる',
    eyebrow: 'The collaborative motion studio',
    title: ['Motion,', 'together.'],
    statement: ['ひとりのアイデアを、', 'みんなの表現に。'],
    introduction: '友人と同じキャンバスを開いて、文字も、図形も、動画も。AI と相談しながら、細部まで自分たちでつくる。',
    newProject: '新しいプロジェクト',
    example: 'サンプルを編集',
    accountNote: 'アカウントなしで、制作・共有を始められます。',
    resume: '前のプロジェクトを開く',
    preparingExample: 'サンプルを準備しています…',
    preparingProject: '新しいプロジェクトを準備しています…',
    cancel: 'キャンセル',
    heroNote: 'Make room for your ideas.',
    seeStudio: 'スタジオを見る',
    editorLabel: 'Poietra の編集画面',
    editorAlt: 'Poietra の実際の編集画面。微分と連鎖律を表す色付きの図形と数式を、レイヤー、プロパティ、タイムラインで編集しています。',
    editorCaption: '制作例：微分と連鎖律',
    editorNote: 'One canvas. Many possibilities.',
    detailEyebrow: 'Made to be edited',
    detailTitle: ['その動きに、', 'あなたの意図を。'],
    detailRhythm: ['位置はゆっくり2秒。', '不透明度は、一瞬の0.3秒。', 'ひとつのオブジェクトにも、別々のリズムを。'],
    detailDescription: '配置を決めたら、場面の間に動きをつける。ベジェ曲線で軌道を描き、開始時刻や長さを調整できます。文字も数式も、あとから一つずつ編集できます。',
    detailLink: 'アイデアを動きにするまで',
    studyTitle: 'A study in motion',
    studyLabel: '動きのデモ',
    studyDescription: '位置は2秒、不透明度は0.3秒で変化する円。下のスライダーで再生位置を操作できます。',
    studyFrom: 'From',
    studyTo: 'To',
    studyCursor: 'You',
    studyTimings: 'デモの時間設定',
    studyPosition: 'Position',
    studyOpacity: 'Opacity',
    studyPositionDuration: '2.0 s',
    studyOpacityDuration: '0.3 s',
    studyControl: 'ドラッグして、動きを確かめる',
    studyRange: '動きのデモの再生位置',
    studyTotal: ' / 2.00 s',
    seconds: '秒',
    workflowEyebrow: 'A shared creative space',
    workflowTitle: ['つくる時間を、', '一緒に。'],
    workflowIntroduction: ['ファイルを送り合う代わりに、', '同じ場所で、次のアイデアへ。'],
    sharingTitle: 'リンクひとつで、同じキャンバス。',
    sharingDescription: '共有 URL を送れば、別の PC からもそのまま参加。友人の編集を見ながら、文字を直したり、図形を動かしたり。ログインなしでも、一緒に作業できます。',
    sharingAside: ['Share a link.', 'Start creating.'],
    aiTitle: 'AI も、制作の輪の中に。',
    aiBeforeMention: 'チャットで ',
    aiAfterMention: ' に相談すると、今のプロジェクトに合わせた編集案が届きます。内容を確認して適用。そのあとも、手で細かく整えられます。',
    aiExampleLabel: 'AI への依頼例',
    aiExampleEyebrow: 'たとえば、こんな相談',
    aiExample: '円を2秒かけて右へ動かして。文字は少し遅れて表示したい。',
    aiReview: '編集案を確認してから適用',
    mediaTitle: '音も映像も、ひとつの作品に。',
    mediaDescription: '画像・動画をキャンバスへ、音声は独立したトラックへ。タイミングをそろえ、作品全体をプレビュー。仕上がったら MP4・WebM に書き出せます。',
    mediaAside: ['Images. Video. Audio.', 'Your composition.'],
    closingEyebrow: 'Your next idea starts here.',
    closingTitle: ['まずは、', 'ひとつ動かしてみる。'],
    closingAction: '空のキャンバスから始める',
    closingNote: 'ひとりで始めて、途中から一緒に。',
    backToTop: 'Poietra ページの先頭へ',
    footerNote: 'Motion, together.',
  },
};
