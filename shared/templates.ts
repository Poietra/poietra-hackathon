import { defaultState, defaultTrack, type AnimationKind, type Composition, type ObjectKind, type ObjectState, type Project, type Scene, type SceneObject, type Transition } from './model';

/** A complete editable scene: a weight's influence travels forward, then its derivative travels back. */
export function makeCalculusProject(): Project {
  const ink = '#e8e8ee', cyan = '#67c4d9', green = '#b5d396', coral = '#ef8078', yellow = '#f4ce55';
  const sceneId = 'calculus';
  const compositions: Composition[] = [
    { id: 'forward', name: 'Forward pass', duration: 2600, accent: cyan, states: {} },
    { id: 'loss', name: 'Measure the error', duration: 2800, accent: yellow, states: {} },
    { id: 'gradient', name: 'Follow the gradient', duration: 4000, accent: coral, states: {} },
  ];
  const objects: Record<string, SceneObject> = {};
  function object(id: string, kind: ObjectKind, name: string, initial: Partial<ObjectState>, next: Partial<ObjectState> = {}, final: Partial<ObjectState> = {}, groupId: string | null = null) {
    objects[id] = { id, name, kind, order: Object.keys(objects).length, locked: false, groupId };
    let state = defaultState(kind, { fill: ink, stroke: ink, strokeWidth: 0, ...initial });
    for (const [index, patch] of [{}, next, final].entries()) {
      state = { ...structuredClone(state), ...patch };
      compositions[index].states[id] = structuredClone(state);
    }
  }
  function equation(id: string, name: string, text: string, x: number, y: number, size: number, color = ink, next: Partial<ObjectState> = {}, final: Partial<ObjectState> = {}, groupId: string | null = null) {
    object(id, 'equation', name, { text, x, y, fontSize: size, width: 320, height: 100, fill: color }, next, final, groupId);
  }
  function node(id: string, label: string, name: string, x: number, toX: number, color: string, visible = true) {
    const group = `group-${id}`;
    object(`${id}-node`, 'circle', `${name} · node`, { x, y: 330, width: 108, height: 108, fill: '#080b10', stroke: color, strokeWidth: 2, visible }, { x: toX, y: 300, visible: true }, id === 'weight' ? { effect: 'glow' } : {}, group);
    equation(`${id}-label`, name, label, x, 330, 44, color, { x: toX, y: 300, visible: true }, {}, group);
    compositions[0].states[`${id}-label`].visible = visible;
  }
  function arrow(id: string, name: string, x: number, y: number, width: number, height: number, color: string, next: Partial<ObjectState> = {}, final: Partial<ObjectState> = {}) {
    object(id, 'arrow', name, { x, y, width, height, fill: color, stroke: color, strokeWidth: 2 }, next, final);
  }

  object('chapter', 'text', 'Chapter', { x: 640, y: 82, text: '01   THE FORWARD PASS', fontSize: 15, fill: cyan }, { text: '02   MEASURE THE ERROR', fill: yellow }, { text: '03   FOLLOW THE GRADIENT', fill: coral });
  object('headline', 'text', 'Headline', { x: 640, y: 131, text: 'A weight becomes an output.', fontSize: 31 }, { text: 'Compare the output with the target.' }, { text: 'One change. Three local sensitivities.' });

  // Nodes identify variables, not operations. a_prev is a fixed input; a is the current output.
  node('weight', 'w', 'Weight w', 250, 160, cyan);
  node('weighted', 'z', 'Weighted sum z', 640, 480, green);
  node('activation', 'a', 'Current activation a', 1030, 800, ink);
  node('cost', 'C', 'Loss C', 1120, 1120, coral, false);

  arrow('weight-edge', 'w → z', 312, 330, 266, 0, cyan, { x: 222, y: 300, width: 196 }, { x: 418, width: -196 });
  arrow('activation-edge', 'z → a', 702, 330, 266, 0, green, { x: 542, y: 300, width: 196 }, { x: 738, width: -196 });
  arrow('cost-edge', 'a → C', 862, 300, 196, 0, coral, { visible: true }, { x: 1058, width: -196 });
  compositions[0].states['cost-edge'].visible = false;
  equation('weighted-operation', 'Fixed input and bias', String.raw`\times a_{\mathrm{prev}}+b`, 445, 248, 27, cyan, { visible: false });
  equation('weighted-equation', 'z = w a_prev + b', String.raw`z = w\,a_{\mathrm{prev}} + b`, 395, 488, 35, green, { x: 330, y: 608, fontSize: 28 }, { visible: false });
  equation('activation-equation', 'a = sigmoid(z)', String.raw`a = \sigma(z)`, 925, 488, 35, ink, { x: 790, y: 608, fontSize: 28 }, { visible: false });
  equation('cost-equation', 'Squared error', String.raw`C = (a-y)^2`, 770, 493, 39, coral, { visible: true }, { visible: false });
  compositions[0].states['cost-equation'].visible = false;

  object('target-node', 'circle', 'Target · node', { x: 1120, y: 464, width: 70, height: 70, fill: '#121108', stroke: yellow, strokeWidth: 1.5, visible: false }, { visible: true }, { visible: false }, 'group-target');
  equation('target-label', 'Target y', 'y', 1120, 464, 36, yellow, { visible: true }, { visible: false }, 'group-target');
  compositions[0].states['target-label'].visible = false;
  arrow('target-edge', 'y → C', 1120, 421, 0, -58, yellow, { visible: true }, { visible: false });
  compositions[0].states['target-edge'].visible = false;
  object('target-caption', 'text', 'Target caption', { x: 1120, y: 530, text: 'target', fontSize: 17, fill: yellow, visible: false }, { visible: true }, { visible: false }, 'group-target');

  equation('weight-derivative', 'Local derivative: dz/dw', String.raw`\frac{\partial z}{\partial w}=a_{\mathrm{prev}}`, 320, 426, 28, cyan, { visible: false }, { visible: true });
  equation('activation-derivative', 'Local derivative: da/dz', String.raw`\frac{\partial a}{\partial z}=\sigma'(z)`, 640, 426, 28, green, { visible: false }, { visible: true });
  equation('cost-derivative', 'Local derivative: dC/da', String.raw`\frac{\partial C}{\partial a}=2(a-y)`, 960, 426, 28, coral, { visible: false }, { visible: true });
  equation('chain-rule', 'Chain rule: dC/dw', String.raw`\frac{\partial C}{\partial w}=2(a-y)\,\sigma'(z)\,a_{\mathrm{prev}}`, 640, 584, 40, ink, { visible: false }, { visible: true });
  for (const id of ['weight-derivative', 'activation-derivative', 'cost-derivative', 'chain-rule']) compositions[0].states[id].visible = false;

  function transition(id: string, fromId: string, toId: string, duration: number): Transition {
    return { id, fromId, toId, duration, tracks: {} };
  }
  const revealLoss = transition('reveal-loss', 'forward', 'loss', 1800);
  const traceGradient = transition('trace-gradient', 'loss', 'gradient', 2100);
  function animate(target: Transition, id: string, type: AnimationKind, start: number, duration: number, sequential = false) {
    target.tracks[id] = defaultTrack(id, { type, start, duration, order: sequential ? 'sequential' : 'together' });
  }
  for (const id of ['weight-node', 'weight-label', 'weighted-node', 'weighted-label', 'activation-node', 'activation-label', 'weight-edge', 'activation-edge', 'weighted-equation', 'activation-equation']) animate(revealLoss, id, 'move', 0, 750);
  animate(revealLoss, 'weighted-operation', 'fade', 0, 300);
  animate(revealLoss, 'cost-edge', 'write', 400, 500);
  animate(revealLoss, 'cost-node', 'grow', 650, 350);
  animate(revealLoss, 'cost-label', 'write', 800, 400);
  animate(revealLoss, 'target-node', 'grow', 850, 350);
  animate(revealLoss, 'target-label', 'write', 1000, 350);
  animate(revealLoss, 'target-edge', 'write', 1100, 400);
  animate(revealLoss, 'target-caption', 'fade', 1100, 400);
  animate(revealLoss, 'cost-equation', 'write', 900, 850, true);

  for (const id of ['target-node', 'target-label', 'target-edge', 'target-caption', 'weighted-equation', 'activation-equation', 'cost-equation']) animate(traceGradient, id, 'fade', 0, 350);
  animate(traceGradient, 'cost-edge', 'move', 150, 350);
  animate(traceGradient, 'cost-derivative', 'write', 300, 450, true);
  animate(traceGradient, 'activation-edge', 'move', 500, 350);
  animate(traceGradient, 'activation-derivative', 'write', 650, 450, true);
  animate(traceGradient, 'weight-edge', 'move', 850, 350);
  animate(traceGradient, 'weight-derivative', 'write', 1000, 450, true);
  animate(traceGradient, 'weight-node', 'move', 1100, 400);
  animate(traceGradient, 'chain-rule', 'write', 1250, 850, true);

  const scene: Scene = {
    id: sceneId, name: 'How a derivative travels', width: 1280, height: 720, background: '#000000', objects,
    compositionOrder: compositions.map(composition => composition.id),
    compositions: Object.fromEntries(compositions.map(composition => [composition.id, composition])),
    transitions: { [revealLoss.id]: revealLoss, [traceGradient.id]: traceGradient },
  };
  return { version: 1, name: 'A change, carried through.', sceneOrder: [sceneId], scenes: { [sceneId]: scene } };
}
