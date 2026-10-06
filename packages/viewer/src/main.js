// Entry point. Mounts the viewer on #videomap (or any [data-videomap] element)
// and exposes window.VideoMap.mount(element, { scene }) for embedding.
import './styles.css';
import { mount } from './viewer.js';

/** Mounted viewers, for scripting and debugging. */
const instances = [];
/** @type {any} */ (window).VideoMap = {
  instances,
  async mount(el, opts) {
    const viewer = await mount(el, opts);
    if (viewer) instances.push(viewer);
    return viewer;
  },
};

const target = /** @type {HTMLElement|null} */ (document.querySelector('#videomap, [data-videomap]'));
if (target) {
  /** @type {any} */ (window).VideoMap.mount(target, { scene: target.dataset.scene || 'scene.json' }).then((viewer) => {
    if (viewer) document.title = viewer.scene.title;
  });
}
