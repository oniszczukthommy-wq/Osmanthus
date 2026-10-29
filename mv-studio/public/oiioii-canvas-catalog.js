// Compatibility API. Public distribution contains no external preset catalogs.
const clone=value=>JSON.parse(JSON.stringify(value));
const CATALOG={meta:{schemaVersion:1,brand:'Osmanthus',coverage:'not-distributed'},templates:[],promptTemplates:[],skills:[],workflowPresets:[],mvWorkflows:[],styles:[],styleCategories:[],styleTabs:[],tools:[],unknowns:[]};
export const OII_CANVAS_CATALOG_META = CATALOG.meta;
export const OII_CANVAS_TEMPLATES = CATALOG.templates;
export const OII_PROJECT_TEMPLATES = CATALOG.templates;
export const OII_PROMPT_TEMPLATES = CATALOG.promptTemplates;
export const OII_CANVAS_SKILLS = CATALOG.skills;
export const OII_WORKFLOW_PRESETS = CATALOG.workflowPresets;
export const OII_MV_WORKFLOWS = CATALOG.mvWorkflows;
export const OII_CANVAS_STYLES = CATALOG.styles;
export const OII_STYLE_CATEGORIES = CATALOG.styleCategories;
export const OII_STYLE_TABS = CATALOG.styleTabs;
export const OII_CANVAS_TOOLS = CATALOG.tools;
export const OII_CATALOG_UNKNOWNS = CATALOG.unknowns;

/** Isolated snapshot; consumers may add explicit execution bindings. */
export function getOiiCanvasCatalog() { return clone(CATALOG); }
export function getOiiCanvasTool(id) { return OII_CANVAS_TOOLS.find(item => item.id === id) || null; }
export function getOiiPromptTemplate(id) { return OII_PROMPT_TEMPLATES.find(item => item.id === id) || null; }
/** Reference panels receive the actual public prompt templates, not local story presets. */
export function getOiiReferenceCatalogs() { return clone({ templates: OII_PROMPT_TEMPLATES, projectTemplates: OII_PROJECT_TEMPLATES, skills: OII_CANVAS_SKILLS, styles: OII_CANVAS_STYLES, styleCategories: OII_STYLE_CATEGORIES }); }
function resolveTemplate(value) {
  const item = typeof value === 'string' ? getOiiPromptTemplate(value) : value;
  if (!item || typeof item.prompt !== 'string') throw new TypeError('模板不存在或没有提示词');
  return item;
}
/** Source slots have defaults rather than named keys. Their stable ids follow occurrence order. */
export function extractTemplateParameters(template) {
  const item = resolveTemplate(template);
  return Array.from(item.prompt.matchAll(/\{\{([\s\S]*?)\}\}/g), (match, index) => ({ id: `parameter_${index + 1}`, index, label: `参数 ${index + 1}`, default: match[1], sourceSyntax: '{{default}}' }));
}
/** Pure text substitution. No eval, provider calls or automatic use of source reference images. */
export function buildTemplatePrompt(template, values = {}) {
  const item = resolveTemplate(template), slots = extractTemplateParameters(item);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('模板参数需要对象');
  const ids = new Set(slots.map(slot => slot.id));
  for (const key of Object.keys(values)) {
    if (!ids.has(key)) throw new TypeError(`未知模板参数：${key}`);
    if (typeof values[key] !== 'string') throw new TypeError(`模板参数需要文字：${key}`);
  }
  let index = 0;
  return item.prompt.replace(/\{\{([\s\S]*?)\}\}/g, (_match, fallback) => {
    const id = `parameter_${++index}`;
    return Object.hasOwn(values, id) ? values[id] : fallback;
  });
}
