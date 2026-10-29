const paths={
back:'<path d="m14 5-7 7 7 7M7 12h14"/>',plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',
'arrow-up':'<path d="M12 20V4m-7 7 7-7 7 7"/>',chevron:'<path d="m6 9 6 6 6-6"/>',
canvas:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 8h8v8H8z"/>',video:'<rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 10 4-3v10l-4-3"/>',
hand:'<path d="M8 12V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v9c0 5-3 7-7 7-3 0-5-2-6-4l-4-6a2 2 0 0 1 3-2l2 2Z"/>',
scan:'<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6M8 8h8v8H8Z"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5"/>',
play:'<path d="m9 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
upload:'<path d="M12 16V4m-4 4 4-4 4 4M5 15v5h14v-5"/>',download:'<path d="M12 4v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
history:'<path d="M3 11a9 9 0 1 1 2.6 7M3 5v6h6m3-5v6l4 2"/>',settings:'<path d="M4 7h10m4 0h2M4 17h2m4 0h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',
link:'<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2" transform="translate(1 0) scale(.9)"/>',
film:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
palette:'<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.2-2.5h1.8A3.5 3.5 0 0 0 21 12a9 9 0 0 0-9-9Z"/><path d="M7 10h.01M10 6.5h.01M15 6.5h.01M18 10h.01" stroke-width="3"/>',book:'<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/>',
crop:'<path d="M7 3v14h14M3 7h14v14"/>',fullscreen:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',captions:'<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9H7v6h3m7-6h-3v6h3"/>',undo:'<path d="M9 5 4 10l5 5m-5-5h10a6 6 0 0 1 0 12" transform="translate(0 -2)"/>',spark:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',check:'<path d="m5 12 4 4L19 6"/>',music:'<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>'};
export function icon(name){return`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]||paths.settings}</svg>`;}
export function hydrateIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));}
