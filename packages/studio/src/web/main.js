// Entry point of the Studio web UI.
import { render } from 'preact';
import { App } from './app.js';
import { start } from './store.js';
import { html } from './ui.js';
import './styles.css';

start();
render(html`<${App} />`, /** @type {HTMLElement} */ (document.getElementById('studio')));
