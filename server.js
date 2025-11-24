// =========================================================
// Carga de variables de entorno y dependencias principales
// Configura Express, CORS, Morgan y Mongoose
// =========================================================
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const morgan   = require('morgan');
const mongoose = require('mongoose');

const app  = express();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 3000;

// =========================================================
// Middlewares de Express y configuración de archivos estáticos
// Sirve imágenes desde frontend/public/mapas y aplica CORS, JSON y logging
// =========================================================
const path = require("path");
const fs   = require("fs");

const MAPAS_DIR = path.resolve(__dirname, "..", "frontend", "public", "mapas");
console.log("Sirviendo /mapas desde:", MAPAS_DIR);

app.use("/mapas", express.static(MAPAS_DIR));

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// =========================================================
// Modelos de datos para Salones y Laboratorios
// Define esquemas Mongoose con índices de texto para búsquedas flexibles
// =========================================================
const { Schema, model, Types } = mongoose;

/*salones*/
const salonSchema = new Schema(
  {
    numero:    { type: String, required: true, index: true },
    nombre:    { type: String, required: true, index: true },
    edificio:  { type: String, required: true, index: true },
    piso:      { type: String, required: true, index: true },
    ubicacion: { type: String },
    mapa_url:  { type: String }
  },
  { versionKey: false, timestamps: false, collection: 'salones' }
);
salonSchema.index({ numero: 'text', nombre: 'text', edificio: 'text', piso: 'text' });
const Salon = model('Salon', salonSchema, 'salones');

/*laboratorios*/
const laboratorioSchema = new Schema(
  {
    codigo:    { type: String, required: true, index: true },
    nombre:    { type: String, required: true, index: true },
    edificio:  { type: String, required: true, index: true },
    piso:      { type: String, required: true, index: true },
    ubicacion: { type: String },
    mapa_url:  { type: String }
  },
  { versionKey: false, timestamps: false, collection: 'laboratorios' }
);
laboratorioSchema.index({ nombre: 'text', codigo: 'text', edificio: 'text', piso: 'text' });
const Laboratorio = model('Laboratorio', laboratorioSchema, 'laboratorios');

// =========================================================
// Conexión a MongoDB y sincronización de índices
// Configura la conexión y sincroniza índices definidos en los esquemas
// =========================================================
mongoose.set('strictQuery', true);
const connectOptions = { serverSelectionTimeoutMS: 8000 };
if (process.env.MONGO_DBNAME) connectOptions.dbName = process.env.MONGO_DBNAME;

mongoose
  .connect(process.env.MONGO_URI, connectOptions)
  .then(async () => {
    console.log('MongoDB conectado');
    try {
      await Promise.all([Laboratorio.syncIndexes(), Salon.syncIndexes()]);
      console.log('Índices sincronizados');
    } catch (e) {
      console.warn('! No se pudieron sincronizar índices:', e.message);
    }
  })
  .catch((err) => {
    console.error('Error al conectar MongoDB:', err.message);
    process.exit(1);
  });

// =========================================================
// Funciones auxiliares de internacionalización y normalización
// Implementa búsquedas tolerantes a acentos y diferencias ortográficas
// =========================================================
const I18N_MAP_CHAT = { a:'aáàäâã', e:'eéèëê', i:'iíìïî', o:'oóòöôõ', u:'uúùüû', n:'nñ', c:'cç' };
const rxEscapeChat = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function i18nLike_chat(s) {
  if (!s) return undefined;
  const pat = String(s).split('').map(ch => {
    const low = ch.toLowerCase();
    return I18N_MAP_CHAT[low] ? `[${I18N_MAP_CHAT[low]}${I18N_MAP_CHAT[low].toUpperCase()}]` : rxEscapeChat(ch);
  }).join('');
  return new RegExp(pat, 'i');
}

function i18nExactRegex_chat(str) {
  const pieces = String(str).split('').map(ch => {
    if (/\s/.test(ch)) return '\\s+';
    const low = ch.toLowerCase();
    return I18N_MAP_CHAT[low] ? `[${I18N_MAP_CHAT[low]}${I18N_MAP_CHAT[low].toUpperCase()}]` : rxEscapeChat(ch);
  });
  return new RegExp('^\\s*' + pieces.join('') + '\\s*$', 'i');
}

const normalize_chat = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();

// =========================================================
// Funciones para detección de imágenes de edificios
// Localiza archivos existentes en la carpeta de mapas o convierte enlaces Drive
// =========================================================
function firstExistingInMapas(basenames = []) {
  const exts = [".png", ".jpg", ".jpeg", ".webp"];
  for (const base of basenames) {
    for (const ext of exts) {
      const full = path.join(MAPAS_DIR, base + ext);
      if (fs.existsSync(full)) {
        return `http://localhost:3000/mapas/${base}${ext}`;
      }
    }
  }
  return ""; // no encontrado
}

function edificioBasenames(edif = "") {
  const t = String(edif || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const candidates = [];

  // “Central”, “Pesados”
  if (/\bcentral\b/.test(t))  candidates.push("EdificioCentral");
  if (/\bpesados?\b/.test(t)) candidates.push("EdificioPesados");

  // Edificio 1..4 (acepta “edificio 1”, “1”, etc.)
  const m = t.match(/\b(?:edificio\s*)?([1-4])\b/);
  if (m) candidates.push(`Edificio${m[1]}`);

  return candidates;
}

// Decide la URL final: primero imagen local por edificio, luego mapa_url/imagen_url (Drive o directa)
function toDirectImage(url = "") {
  if (!url) return "";
  const m = String(url).match(/https:\/\/drive\.google\.com\/file\/d\/([^/]+)/i);
  if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  return url; // ya directa
}

function pickBuildingImage(doc = {}) {
  // 1) Buscar por edificio / ubicación / nombre → archivo local existente
  const byEd = [
    ...edificioBasenames(doc.edificio || ""),
    ...edificioBasenames(doc.ubicacion || ""),
    ...edificioBasenames(doc.nombre || doc.codigo || ""),
  ];
  const localUrl = firstExistingInMapas(byEd);
  if (localUrl) return localUrl;

  // 2) Fallback a campos de BD
  const fallback = doc.mapa_url || doc.imagen_url || "";
  return toDirectImage(fallback);
}

// =========================================================
// Mapeo de sinónimos y normalización de términos
// Define diccionarios para equivalencias en nombres de salones y laboratorios
// =========================================================
const normalize = (s) => normalize_chat(s);

const SALON_NUMS = [
  100,102,103,104,105,106,120,121,122,123,124,125,126,
  201,202,211,221,222,223,224,225,226,
  315,322,323,324,325,326,
  422,423,424,425,426
];
const SALON_LS = ['L320','L325'];

function buildSalonSynonyms() {
  const map = {};
  const base = (n) => `Salón ${n}`;
  for (const n of SALON_NUMS) {
    const canon = base(n);
    map[canon] = [
      `${n}`,
      `salon ${n}`, `salón ${n}`,
      `aula ${n}`,
      `aula${n}`, `salon${n}`, `salón${n}`,
      `Salon ${n}`, `Salón ${n}`,
      `Aula ${n}`,
      `Aula${n}`, `Salon${n}`, `Salón${n}`
    ];
  }
  for (const lx of SALON_LS) {
    const canon = `Aula ${lx.toUpperCase()}`;
    const code  = lx.toUpperCase();
    map[canon] = [
      `${code}`, `${code.toLowerCase()}`,
      `aula ${code}`, `salon ${code}`, `salón ${code}`,
      `aula${code}`, `salon${code}`, `salón${code}`,
      `sala ${code}`,
      `Aula ${code}`, `Salon ${code}`, `Salón ${code}`,
      `Aula${code}`, `Salon${code}`, `Salón${code}`,
      `Sala ${code}`
    ];
  }
  return map;
}
const SALON_SYNONYMS = buildSalonSynonyms();

// =========================================================
// Definición de sinónimos para laboratorios y espacios comunes
// Amplía cobertura de términos en consultas naturales
// =========================================================
const LAB_SYNONYMS = {
  'Sala multimedia': ['sala de multimedia','multimedia','sala de multi','sala multimedia', 'Sala de Multimedia',
    'Multimedia', 'Sala de multi', 'Multi', 'multi', 'multimedia'
  ],
  'Biblioteca': ['la biblioteca','biblioteca', 'Biblioteca', 'La biblioteca'],
  'CELEX': ['celex', 'Celex'],
  'Sala de alumnos de Posgrado': ['sala de alumnos de posgrado','alumnos posgrado', 'Sala de alumnos de posgrado'],
  'Red de Género': ['red de genero','genero', 'Red de género', 'red de género'],
  'Red de Expertos Posgrado': ['red de expertos posgrado','red de expertos','posgrado red de expertos',
    'Red de expertos posgrado'
  ],
  'Laboratorio de Desarrollo Tecnológico': [
    'Desarrollo Tecnológico','Desarrollo tecnológico','Lab de Desarrollo Tecnológico','lab de desarrollo tecnológico',
    'laboratorio de desarrollo tecnológico','desarrollo tecnologico','laboratorio de desarrollo tecnologico',
    'lab de desarrollo tecnologico', ' Lab de desarrollo tecnológico', 'Laboratorio de desarrollo tecnológico'
  ],
  'Laboratorio de Realidad Extendida': [
    'Laboratorio de realidad extendida','Lab de realidad extendida','Realidad extendida','laboratorio de realidad extendida',
    'lab de realidad extendida'
  ],
  'Laboratorio CIM': ['Lab CIM','CIM','cim','lab cim','laboratorio cim','lab CIM','laboratorio CIM'],
  'Laboratorio de Electrónica 3': [
    'electronica 3','electronica iii','lab de electronica 3','lab de electronica iii',
    'Electrónica 3','Lab de electrónica 3','electrónica 3','Electrónica III','lab de electrónica III', 'Lab De Electrónica 3',
    'lab de electrónica 3', 'Lab de electrónica III', 'Lab De Electrónica III', 'Electronica 3','Lab de electronica 3',
    'electronica III','electrónica III','lab de electronica III', 'Electronica III', 'Lab De Electronica III', 'Lab de electronica III',
    'electrónica iii', 'lab de electrónica iii', 'Electrónica iii','Lab de electrónica iii', 'Lab De Electrónica iii',
    'Lab de electronica iii', 'Lab De Electronica iii'
  ],
  'Laboratorio de Robótica Avanzada y Televisión Interactiva': [
    'lab de robotica avanzada','robótica avanzada','laboratorio de robótica avanzada', 'robotica avanzada','television interactiva',
    'Laboratorio de robótica avanzada', 'Lab de robótica avanzada', 'laboratorio de robotica avanzada', 'lab de robótica avanzada',
    'Lab De Robótica Avanzada', 'Lab de robotica avanzada','Robótica avanzada', 'Robotica avanzada','Television interactiva',
    'Laboratorio de robotica avanzada', 'lab De Robótica Avanzada'
  ],
  'Laboratorio de Síntesis Química Posgrado': [
    'Lab de Sintesis','lab de síntesis','lab de sintesis quimica posgrado', 'laboratorio de síntesis','síntesis química posgrado',
    'Lab de Sintesis Quimica Posgrado', 'lab de síntesis química posgrado', 'Lab de Síntesis Química Posgrado', 'Lab de síntesis química posgrado',
    'Laboratorio de Sintesis', 'laboratorio de sintesis', 'Laboratorio de Síntesis'
  ],
  'Laboratorio de Imagen y Procesamiento de Señales': [
    'imagen y procesamiento de señales','laboratorio de imagen','procesamiento de señales', 'laboratorio de imagen y procesamiento de señales',
    'Laboratorio de imagen', 'Laboratorio de Imagen','Laboratorio de imagen y procesamiento de señales', 'Imagen y procesamiento de señales',
    'Procesamiento de señales', 'laboratorio de Imagen'
  ],
  'Laboratorio de Fenómenos Cuánticos': ['fenomenos cuanticos','lab de fenomenos cuanticos','laboratorio de fenómenos cuánticos',
    'Lab de Fenómenos Cuánticos', 'lab de fenómenos cuánticos', 'Lab de fenómenos cuánticos', 'laboratorio de fenómenos cuánticos',
    'lab de Fenómenos Cuánticos', 'Laboratorio de fenómenos cuánticos'
  ],
  'Laboratorio de Fototérmicas': ['fototermicas','fototérmicas','lab de fototermicas','laboratorio de fototérmicas', 'Lab de Fototérmicas',
    'Lab de fototérmicas', 'lab de fototérmicas', 'Fototermicas','Fototérmicas','Lab de fototermicas','Laboratorio de fototérmicas',
    'lab de Fototérmicas' 
  ],
  'Laboratorio de Nanomateriales y Nanotecnología': [
    'lab de nanomateriales','nanomateriales y nanotecnologia','laboratorio de nanomateriales y nanotecnología',
    'Lab de Nanomateriales y Nanotecnología', 'lab de nanomateriales y nanotecnología', 'Lab de nanomateriales y nanotecnología', 
    'Laboratorio de Nanomateriales', 'Laboratorio de nanomateriales'
  ],
  'Trabajo Terminal Mecatrónica': [
    'Laboratorio de Trabajo Terminal Meca','tt meca','TT meca','trabajo terminal mecatronica','Trabajo Terminal Mecatrónica','TT mecatrónica',
    'Laboratorio de Trabajo Terminal Mecatrónica', 'laboratorio de trabajo terminal mecatrónica', 'Laboratorio de trabajo terminal mecatrónica', 
    'Laboratorio de TT Mecatrónica', 'laboratorio de tt mecatrónica', 'Laboratorio de tt mecatrónica', 'Laboratorio de TT mecatrónica',
    'Tt mecatrónica', 'Laboratorio de Trabajo Terminal Meca', 'laboratorio de trabajo terminal meca', 'Laboratorio de trabajo terminal meca', 
    'Laboratorio de TT Meca', 'laboratorio de tt meca', 'Laboratorio de tt meca', 'Laboratorio de TT meca', 'TT Meca', 'tt meca', 'Tt meca', 
    'TT meca'
  ],
  'Laboratorio de Sistemas Complejos': ['lab de sistemas complejos','sistemas complejos', 'Laboratorio de sistemas complejos',
    'Lab De Sistemas Complejos', 'Lab de sistemas complejos', 'laboratorio de sistemas complejos'
  ],
  'Laboratorio de Química y Biología': [
    'lab de química','quimica y biologia','laboratorio de química y biología', 'Lab de química y biología', 'lab de química y biología', 
    'Lab de Química y Biología', 'lab de quimica', 'Lab de Quimica', 'Lab de quimica', 'Laboratorio de química y biología',
    'laboratorio de quimica y biologia', 'Laboratorio de Química', 'Laboratorio de química', 'laboratorio de química'
  ],
  'Laboratorio de Física': ['fisica','lab de fisica','Laboratorio de Física','laboratorio de física', 'Laboratorio de Fisica', 'Lab de física',
    'Lab de fisica', 'lab de física', 'Lab de Física', 'Laboratorio de física', 'laboratorio de fisica'
  ],
  'Laboratorio de Cómputo Móvil': [
    'computo movil','cómputo móvil','lab de computo movil','laboratorio de cómputo móvil', 'laboratorio de computo movil','lab de cómputo móvil',
    'Laboratorio de cómputo móvil', 'Laboratorio de computo movil', 'laboratorio de computo movil', 'Cómputo móvil', 'Lab de cómputo móvil', 
    'Lab de Cómputo Móvil'
  ],
  'Laboratorio de Telemática II': [
    'lab de telematica ii','tele 2','tele ii','telematica 2','telemática 2','telematica ii','Telemática II', 'Laboratorio de telemática II', 
    'laboratorio de telemática II', 'laboratorio de telemática ii', 'Tele II', 'Tele ii', 'tele II', 'Telematica II', 'telematica II', 
    'Telemática ii', 'Telemática 2', 'Telematica 2'
  ],
  'Laboratorio de Telemática I': [
    'lab de telematica 1','lab de telematica i','tele 1','tele i','telematica 1','telemática i','Telemática I', 'Laboratorio de telemática I',
    'laboratorio de telemática I', 'laboratorio de telemática i', 'Tele I', 'Tele i', 'tele I', 'Telemática 1', 'telemática 1', 'Telematica 1'
  ],
  'Laboratorio de Electrónica II': [
    'electronica 2','electrónica 2','electronica ii','Electrónica II','lab de electronica 2','lab de electrónica II', 'Electrónica 2',
    'Lab de electrónica 2', 'Lab De Electrónica 2', 'electrónica II', 'lab de electrónica 2', 'Lab de electrónica II', 'Lab De Electrónica II', 
    'electronica II', 'electrónica ii', 'Electrónica ii','lab de electronica ii','lab de electrónica ii', 'Electrónica ii',
    'Lab de electrónica ii', 'Lab De Electrónica ii', 'lab de electronica II'    
  ],
  'Laboratorio de Sistemas Digitales II': [
    'Laboratorio de Sistemas Digitales 2','sd 2','sd ii','SD2','sd2','SDII','sd-2','sistemas digitales ii','Sistemas Digitales II',
    'sistemas digitales 2', 'sistemas digitales II', 'Sistemas digitales II', 'Sistemas digitales 2', 'sdII', 'sdii', 'sd II', 'SD II', 'sd-II',
    'Laboratorio de Sistemas Digitales ii', 'sd ii', 'SDii', 'SDii', 'sd-ii', 'Sistemas Digitales ii', 'Sistemas digitales ii', 'sd-2',
    'Sistemas Digitales 2'
  ],
  'Laboratorio de Bioelectrónica': ['bioelectronica','bioelectrónica','lab de bioelectrónica','laboratorio de bioelectrónica', 'Bioelectrónica',
    'Bioelectronica', 'Lab de bioelectrónica', 'Laboratorio de bioelectronica', 'laboratorio de bioelectronica'
  ],
  'Laboratorio de Robótica de Competencias y Agentes Inteligentes': [
    'agentes inteligentes','robotica de competencias','robótica de competencias', 'Laboratorio de robótica de competencias y agentes inteligentes',
    'Robótica de Competencias y Agentes Inteligentes', 'Robótica de Competencias', 'robótica de competencias y agentes inteligentes',
    'Robótica de competencias y agentes inteligentes'
  ],
  'Laboratorio de Electrónica I': [
    'electronica 1','electrónica 1','electronica i','Electrónica I','Lab de electrónica 1', 'lab de electronica 1', 'lab de electrónica I',
    'Electrónica 1', 'Lab De Electrónica 1', 'electrónica I', 'lab de electrónica 1', 'Lab de electrónica I', 'Lab De Electrónica I',
    'electronica I', 'electrónica i', 'Electrónica i','lab de electronica i', 'lab de electrónica i', 'Lab de electrónica i',
    'Lab De Electrónica i', 'lab de electronica I'    
  ],
  'Laboratorio de Sistemas Digitales': [
    'Laboratorio de sistemas digitales','sd','SD','sistemas digitales','Sistemas Digitales', 'Sistemas digitales',
    'laboratorio de Sistemas Digitales'
  ],
  'Laboratorio de Telecomunicaciones': [
    'telecomunicaciones','lab de telecom','telecom','Laboratorio de telecomunicaciones', 'Telecom', 'Lab de Telecom', 'Laboratorio de Telecom',
    'laboratorio de telecom', 'Lab de telecom', 'Laboratorio de telecom', 'laboratorio de telecomunicaciones', 'Telecomunicaciones', 'tele'
  ],
  'Laboratorio de Trabajo Terminal Telemática': [
    'laboratorio de trabajo terminal telematica',
    'laboratorio de trabajo terminal telemática',
    'lab tt tele', 'lab ttt', 'ttt', 'TTT', 'tt tele',
    'tt telematica', 'tt telemática', 'lab tt telematica', 'lab tt telemática',
    'proyecto terminal tele', 'proyecto terminal telematica', 'proyecto terminal telemática',
    'ptt', 'p.t.t', 'pt tele', 'pt telematica', 'pt telemática',
    'trabajo terminal telematica', 'trabajo terminal telemática',
    'proy terminal tele', 'proy terminal telematica', 'proy terminal telemática'
  ],

  'Laboratorio de Robótica Industrial': [
    'lab de robotica industrial','robótica industrial','Laboratorio de robótica industrial', 'Robótica Industrial', 'Lab de Robótica Industrial',
    'robotica industrial', 'lab de robótica industrial', 'laboratorio de robótica industrial', 'Robótica industrial', 'Lab de robótica industrial',
    'Laboratorio de robotica industrial', 'Robotica Industrial', 'Lab de Robotica Industrial','Robotica industrial', 'Lab de robotica industrial'
  ],
  'Laboratorio de Manufactura Básica': [
    'lab de manufactura basica','manufactura básica','Laboratorio de manufactura básica', 'Laboratorio de Manufactura Basica',
    'Laboratorio de manufactura basica', 'Manufactura Básica', 'Manufactura Basica', 'Manufactura basica', 'manufactura basica',
    'laboratorio de manufactura básica', 'Manufactura básica'
  ],
  'Laboratorio de Manufactura Avanzada': [
    'lab de manufactura avanzada','Manufactura Avanzada','Laboratorio de manufactura avanzada', 'laboratorio de manufactura avanzada', 
    'Manufactura avanzada', 'manufactura avanzada'
  ],
  'Laboratorio de Meteorología': [
    'lab de meteorologia','meteorología','Laboratorio de meteorología', 'laboratorio de meteorología', 'laboratorio de meteorologia',
    'Laboratorio de meteorologia', 'Meteorologia', 'Meteorología', 'meteorologia', 'Lab de meteorología', 'lab de meteorología',
    'Lab de meteorologia'
  ],
  'Laboratorio de Red de Expertos': [
    'lab de red de expertos','red de expertos','Red de Expertos', 'Laboratorio de red de expertos', 'laboratorio de red de expertos',
    'Red de expertos', 'Lab de Red de Expertos', 'Lab de red de expertos'
  ],
  'Trabajo Terminal': [
    'Laboratorio de TT','laboratorio de trabajo terminal','tt','TT', 'Trabajo terminal', 'Laboratorio de Trabajo Terminal',
    'Laboratorio de trabajo terminal', 'Laboratorio de tt', 'laboratorio de tt', 'laboratorio de TT', 'Tt'
  ],
  'Laboratorio de Manufactura Asistida por Computadora de la Red de Expertos': [
    'lab de manufactura asistida','MAC','mac','manufactura asistida', 'manufactura asistida por computadora de la red de expertos',
    'red de expertos', 'Laboratorio de manufactura asistida por computadora de la red de expertos',     
    'laboratorio de manufactura asistida por computadora de la red de expertos', 'Manufactura Asistida', 'laboratorio de manufactura asistida',
    'Manufactura asistida'
  ],
  'Laboratorio de Cálculo y Simulación 2': [
    'calculo y simulacion 2','cálculo y simulación 2','lab de cálculo y simulación 2', 'laboratorio de cálculo y simulación 2',
    'Laboratorio de cálculo y simulación 2', 'lab de cálculo y simulación 2', 'Lab de cálculo y simulación 2', 
    'Laboratorio de Calculo y Simulacion 2', 'lab de calculo y simulacion 2', 'laboratorio de calculo y simulacion 2', 
    'Laboratorio de calculo y simulacion 2', 'Lab de calculo y simulacion 2'
  ],
  'Laboratorio de Cálculo y Simulación 1': [
    'calculo y simulacion 1','cálculo y simulación 1','lab de cálculo y simulación 1', 'laboratorio de cálculo y simulación 1',
    'Laboratorio de cálculo y simulación 1', 'lab de cálculo y simulación 1', 'Lab de cálculo y simulación 1', 
    'Laboratorio de Calculo y Simulacion 1', 'lab de calculo y simulacion 1', 'laboratorio de calculo y simulacion 1', 
    'Laboratorio de calculo y simulacion 1', 'Lab de calculo y simulacion 1'
  ],
  'Laboratorio de Biomecánica': [
    'biomecanica','biomecánica','lab de biomecánica','Laboratorio de biomecánica', 'Laboratorio de biomecanica', 'laboratorio de biomecánica',
    'laboratorio de biomecanica', 'Biomecánica', 'Biomecanica', 'Lab de biomecánica', 'Lab de biomecanica', 'lab de biomecanica',
    'Lab de Biomecánica'
  ],
  'Sala de Cómputo 1': [
    `sala de computo 1`, `sala de cómputo 1`, `computo 1`, `cómputo 1`, `sc1`, `sc 1`,
    `Sala de computo 1`, `Sala de cómputo 1`, `Sala de Computo 1`,
    `Computo 1`, `Cómputo 1`, `SC1`, `SC 1`, `Sc1`, `Sc 1`
  ],
  'Sala de Cómputo 2': [
    `sala de computo 2`, `sala de cómputo 2`, `computo 2`, `cómputo 2`, `sc2`, `sc 2`,
    `Sala de computo 2`, `Sala de cómputo 2`, `Sala de Computo 2`,
    `Computo 2`, `Cómputo 2`, `SC2`, `SC 2`, `Sc2`, `Sc 2`
  ],
  'Laboratorio de Neumática y Control de Procesos': [
'Laboratorio de neumática y control de procesos', 'laboratorio de neumática y control de procesos', 'laboratorio de neumática', 'Laboratorio de neumática', 'neumática y control de procesos', 'Neumática y control de procesos', 'Lab de neumática y control de procesos', 'lab de neumática y control de procesos',
'Laboratorio de neumatica y control de procesos', 'laboratorio de neumatica y control de procesos', 'laboratorio de neumatica', 'Laboratorio de neumatica', 'neumatica y control de procesos', 'Neumatica y control de procesos', 'Lab de neumatica y control de procesos', 'lab de neumatica y control de procesos',
],
'Sala de profesores 1': [
'Sala de Profesores 1', 'Sala de profes 1', 'sala de profesores 1', 'Profesores 1', 'profes 1', 'profesores 1', 'Profes 1'
],
'Sala de profesores 2': [
'Sala de Profesores 2', 'Sala de profes 2', 'sala de profesores 2', 'Profesores 2', 'profes 2', 'profesores 2', 'Profes 2'
],
'Sala de profesores 3': [
'Sala de Profesores 3', 'Sala de profes 3', 'sala de profesores 3', 'Profesores 3', 'profes 3', 'profesores 3', 'Profes 3'
],
'Sala de profesores 4': [
'Sala de Profesores 4', 'Sala de profes 4', 'sala de profesores 4', 'Profesores 4', 'profes 4', 'profesores 4', 'Profes 4'
],
'Sala de profesores 5': [
'Sala de Profesores 5', 'Sala de profes 5', 'sala de profesores 5', 'Profesores 5', 'profes 5', 'profesores 5', 'Profes 5'
],
'Sala de profesores 6': [
'Sala de Profesores 6', 'Sala de profes 6', 'sala de profesores 6', 'Profesores 6', 'profes 6', 'profesores 6', 'Profes 6'
],
'Sala de profesores 7': [
'Sala de Profesores 7', 'Sala de profes 7', 'sala de profesores 7', 'Profesores 7', 'profes 7', 'profesores 7', 'Profes 7'
],
'Sala de profesores 8': [
'Sala de Profesores 8', 'Sala de profes 8', 'sala de profesores 8', 'Profesores 8', 'profes 8', 'profesores 8', 'Profes 8'
],
'Sala de profesores 9': [
'Sala de Profesores 9', 'Sala de profes 9', 'sala de profesores 9', 'Profesores 9', 'profes 9', 'profesores 9', 'Profes 9'
],
'Sala de profesores 10': [
'Sala de Profesores 10', 'Sala de profes 10', 'sala de profesores 10', 'Profesores 10', 'profes 10', 'profesores 10', 'Profes 10'
],
'Sala de profesores 11': [
'Sala de Profesores 11', 'Sala de profes 11', 'sala de profesores 11', 'Profesores 11', 'profes 11', 'profesores 11', 'Profes 11'
],
'Sala de profesores 12': [
'Sala de Profesores 12', 'Sala de profes 12', 'sala de profesores 12', 'Profesores 12', 'profes 12', 'profesores 12', 'Profes 12'
],
'Sala de profesores 13': [
'Sala de Profesores 13', 'Sala de profes 13', 'sala de profesores 13', 'Profesores 13', 'profes 13', 'profesores 13', 'Profes 13'
],
'Sala de profesores telemática': [
'Sala de Profesores Telemática', 'Sala de profes telemática', 'sala de profesores telemática', 'Profesores telemática', 'profes telemática', 'profesores telemática', 'Profes telemática',
'Sala de Profesores Telematica', 'Sala de profes telematica', 'sala de profesores telematica', 'Profesores telematica', 'profes telematica', 'profesores telematica', 'Profes telematica',
'Sala de Profesores Tele', 'Sala de profes tele', 'sala de profesores tele', 'Profesores tele', 'profes tele', 'profesores tele', 'Profes tele'
],
};
// Salas de Cómputo 1..10
for (let i = 1; i <= 20; i++) {
  LAB_SYNONYMS[`Sala de Cómputo ${i}`] = [
    `sala de computo ${i}`, `sala de cómputo ${i}`,
    `computo ${i}`, `cómputo ${i}`, `sc${i}`, `sc ${i}`,
    `Sala de computo ${i}`, `Sala de cómputo ${i}`, `Sala de Computo ${i}`,
    `Computo ${i}`, `Cómputo ${i}`, `SC${i}`, `SC ${i}`, `Sc${i}`, `Sc ${i}`
  ];
}

// =========================================================
// Generadores y detectores de sinónimos canónicos
// Convierte textos de usuario a nombres oficiales almacenados en la BD
// =========================================================
function buildSynMap(obj) {
  const map = new Map();
  for (const [canonical, list] of Object.entries(obj)) {
    map.set(normalize(canonical), canonical);
    for (const syn of list) map.set(normalize(syn), canonical);
  }
  return map;
}
const SYN_MAP_SALON = buildSynMap(SALON_SYNONYMS);
const SYN_MAP_LAB   = buildSynMap(LAB_SYNONYMS);

function detectCanonicalSalon(text) {
  const t = normalize(text || '');
  if (!t) return '';
  for (const [nsyn, canonical] of SYN_MAP_SALON.entries()) {
    if (t.includes(nsyn)) return canonical;
  }
  const m = t.match(/\bl\s*(\d{3})\b/i);
  if (m) return `Aula L${m[1]}`;
  return '';
}

// =========================================================
// Utilidades específicas de desambiguación
// Resuelve variantes para Sistemas Digitales y Telemática
// =========================================================
function resolveSDCanonical(text) {
  const t = normalize(text || '');
  if (!t) return '';
  if (/\bsd\s*(ii|2)\b/.test(t) || /\bsistemas\s+digitales\s*(ii|2)\b/.test(t))
    return 'Laboratorio de Sistemas Digitales II';
  if (/\bsd\s*(i|1)\b/.test(t) || /\bsistemas\s+digitales\s*(i|1)\b/.test(t))
    return 'Laboratorio de Sistemas Digitales';
  if (/\bsd\b/.test(t) || /\bsistemas\s+digitales\b/.test(t))
    return 'Laboratorio de Sistemas Digitales';
  return '';
}
function resolveTeleCanonical(text) {
  const t = normalize(text || '');
  if (!t) return '';
  if (/\btele\s*(ii|2)\b/.test(t) || /\btelematica\s*(ii|2)\b/.test(t))
    return 'Laboratorio de Telemática II';
  if (/\btele\s*(i|1)\b/.test(t) || /\btelematica\s*(i|1)\b/.test(t))
    return 'Laboratorio de Telemática I';
  if (/\btele\b/.test(t) || /\btelematica\b/.test(t))
    return 'Laboratorio de Telemática I';
  return '';
}
function detectCanonicalLab(text) {
  const t = normalize(text || '');
  if (!t) return '';

  // Sistemas Digitales
  const sdCanon = resolveSDCanonical(t);
  if (sdCanon) return sdCanon;

  // Telemática I / II
  const teleCanon = resolveTeleCanonical(t);
  if (teleCanon) return teleCanon;

  // ---Trabajo Terminal Telemática ---
  if (
    /\b(ttt|p\.?t\.?t|tt\s*tele|proy(ecto)?\s+terminal|trabajo\s+terminal)\b/.test(t) &&
    /\btele(matica|mática)?\b/.test(t)
  ) {
    // devolvemos el canónico más amplio (como lo tienes en Mongo)
    return 'Laboratorio de Trabajo Terminal Telemática';
  }

  // --- Proyecto Terminal Mecatrónica ---
  if (
    /\b(tt|proy(ecto)?|trabajo)\s+terminal\b.*\b(meca(tronica|trónica)?)\b/.test(t)
  ) {
    return 'Trabajo Terminal Mecatrónica';
  }

  if (
    /\b(lab(?:oratorio)?\s*de\s*)?electr[oó]nica\s*i(?!i)\b/.test(t) ||
    /\b(lab(?:oratorio)?\s*de\s*)?electr[oó]nica\s*1\b/.test(t)
  ) {
    return 'Laboratorio de Electrónica I';
  }

  // --- Resto de sinónimos conocidos ---
  for (const [nsyn, canonical] of SYN_MAP_LAB.entries()) {
    if (t.includes(nsyn)) return canonical;
  }
  return '';
}

// Normalizador “libre” para búsqueda difusa
function applySynonyms_chat(term) {
  let s = String(term || '').trim();
  s = s.replace(/\bsc\s*(\d+)\b/ig, 'Sala de Cómputo $1');
  s = s.replace(/\bsala\s*de\s*c[oó]mputo\s*(\d+)\b/ig, 'Sala de Cómputo $1');
  s = s.replace(/\bsc\s*(\d+)\b/ig, 'Sala de Cómputo $1');
  s = s.replace(/\bc[oó]mputo\s*(\d+)\b/ig, 'Sala de Cómputo $1');
  s = s.replace(/\bC[oó]mputo\s*(\d+)\b/ig, 'Sala de Cómputo $1');
  s = s.replace(/\brealidad\s*ext(endida)?\b/ig, 'Realidad Extendida');
  s = s.replace(/\bdesarrollo\s+tec(?:hnol[oó]gico|nol[oó]gico|nolog(?:ico|ico))\b/ig, 'Desarrollo Tecnológico');
  s = s.replace(/\bsd\s*i\b/ig,  'Sistemas Digitales I');
  s = s.replace(/\bsd\s*1\b/ig,  'Sistemas Digitales I');
  s = s.replace(/\bsd\s*ii\b/ig, 'Sistemas Digitales II');
  s = s.replace(/\bsd\s*2\b/ig,  'Sistemas Digitales II');
  s = s.replace(/\bsd-?2\b/ig,   'Sistemas Digitales II');
  s = s.replace(/\bttt\b/ig,                     'Trabajo Terminal Telemática');
  s = s.replace(/\btt\s*tele(?:m[aá]tica)?\b/ig, 'Trabajo Terminal Telemática');
    // Proyecto/Trabajo Terminal Telemática → canónico
  s = s.replace(/\bptt\b/ig, 'Trabajo Terminal Telemática');
  s = s.replace(/\bp\.t\.t\b/ig, 'Trabajo Terminal Telemática');
  s = s.replace(/\bpt\s+tele(matica|mática)?\b/ig, 'Trabajo Terminal Telemática');
  s = s.replace(/\bproy(ecto)?\s+terminal\s+tele(matica|mática)?\b/ig, 'Trabajo Terminal Telemática');
  s = s.replace(/\b(proyecto|trabajo)\s+terminal\s+tele(matica|mática)?\b/ig, 'Trabajo Terminal Telemática');
  s = s.replace(/\btt\s*meca(?:tr[oó]nica)?\b/ig,'Trabajo Terminal Mecatrónica');
  s = s.replace(/\btele\s*ii\b/ig, 'Laboratorio de Telemática II');
  s = s.replace(/\btele\s*2\b/ig,  'Laboratorio de Telemática II');
  s = s.replace(/\btele\s*i\b/ig,  'Laboratorio de Telemática I');
  s = s.replace(/\btele\s*1\b/ig,  'Laboratorio de Telemática I');
  s = s.replace(/\btelematica\s*ii\b/ig, 'Laboratorio de Telemática II');
  s = s.replace(/\btelematica\s*2\b/ig,  'Laboratorio de Telemática II');
  s = s.replace(/\btelematica\s*i\b/ig,  'Laboratorio de Telemática I');
  s = s.replace(/\btelematica\s*1\b/ig,  'Laboratorio de Telemática I');
  s = s.replace(/\bcim\b/ig, 'CIM');
  s = s.replace(/\belectronica\s*iii\b/ig, 'Electrónica 3');
  s = s.replace(/\belectronica\s*ii\b/ig,  'Electrónica II');
  s = s.replace(/\belectronica\s*i\b/ig,   'Electrónica I');
s = s.replace(/\b(lab(?:oratorio)?\s*de\s*)?electronica\s*i(?!i)\b/ig, 'Laboratorio de Electrónica I');
s = s.replace(/\b(lab(?:oratorio)?\s*de\s*)?electronica\s*1\b/ig, 'Laboratorio de Electrónica I');
s = s.replace(/\belectronica\s*i(?!i)\b/ig, 'Laboratorio de Electrónica I');
s = s.replace(/\belectronica\s*1\b/ig, 'Laboratorio de Electrónica I');

  return s.replace(/\s{2,}/g, ' ').trim();
}

// =========================================================
// Funciones auxiliares para códigos L###
// Extraen o generan variantes de nombres de aulas
// =========================================================
// Para detectar “L###” con o sin espacio/guion
function lCodeFrom(text) {
  const t = String(text || '');
  const m = t.match(/\b[Ll]\s*-?\s*(\d{3})\b/);
  return m ? `L${m[1]}` : '';
}
// Variantes si en BD hay “Aula/Salón L###”
function lVariants(code) {
  return [`Aula ${code}`, `Salón ${code}`, `Salon ${code}`, `Sala ${code}`, `${code}`];
}

// =========================================================
// Endpoints REST de información general y catálogos
// Define rutas de estado, salones y laboratorios con soporte i18n
// =========================================================
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    message: 'API Chatbot UPIITA',
    endpoints: ['/health','/salones','/laboratorios','/buscar','/chat','/chat/df']
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// =========================================================
// Endpoint GET /salones
// Obtiene listado de salones con filtros y paginación
// =========================================================
app.get('/salones', async (req, res, next) => {
  try {
    const q = {};
    if (req.query.nombre) {
      const nombreQ = String(req.query.nombre);
      const lcode = lCodeFrom(nombreQ);
      if (lcode) {
        const variants = lVariants(lcode);
        const data = await Salon.find({ nombre: { $in: variants } })
          .collation({ locale: 'es', strength: 1 }).lean();
        return res.json({ page: 1, limit: data.length || 50, total: data.length, totalPages: 1, data });
      }
      q.nombre = i18nLike_chat(nombreQ);
    }
    if (req.query.numero)   q.numero   = i18nLike_chat(req.query.numero);
    if (req.query.edificio) q.edificio = i18nLike_chat(req.query.edificio);
    if (req.query.piso)     q.piso     = i18nLike_chat(req.query.piso);

    const limit = Math.min(Math.max(parseInt(req.query.limit || '50',10),1),200);
    const page  = Math.max(parseInt(req.query.page || '1',10),1);
    const skip  = (page - 1) * limit;

    const [ total, data ] = await Promise.all([
      Salon.countDocuments(q),
      Salon.find(q).sort({ numero: 1, nombre: 1 }).skip(skip).limit(limit).lean()
    ]);

    res.json({ page, limit, total, totalPages: Math.ceil(total/limit), data });
  } catch (e) { next(e); }
});

app.get('/salones/:id', async (req, res, next) => {
  try {
    if (!Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const doc = await Salon.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'No encontrado' });
    res.json(doc);
  } catch (e) { next(e); }
});

// =========================================================
// Endpoint GET /laboratorios
// Devuelve listado de laboratorios filtrado y paginado
// =========================================================
app.get('/laboratorios', async (req, res, next) => {
  try {
    const q = {};
    const term = req.query.q || req.query.nombre;
    if (term) q.$or = [{ nombre: i18nLike_chat(term) }, { codigo: i18nLike_chat(term) }];
    if (req.query.edificio) q.edificio = i18nLike_chat(req.query.edificio);
    if (req.query.piso)     q.piso     = i18nLike_chat(req.query.piso);

    const limit = Math.min(Math.max(parseInt(req.query.limit || '50',10),1),200);
    const page  = Math.max(parseInt(req.query.page || '1',10),1);
    const skip  = (page - 1) * limit;

    const [ total, data ] = await Promise.all([
      Laboratorio.countDocuments(q),
      Laboratorio.find(q).sort({ nombre: 1 }).skip(skip).limit(limit).lean()
    ]);

    res.json({ page, limit, total, totalPages: Math.ceil(total/limit), data });
  } catch (e) { next(e); }
});

app.get('/laboratorios/:id', async (req, res, next) => {
  try {
    if (!Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const doc = await Laboratorio.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'No encontrado' });
    res.json(doc);
  } catch (e) { next(e); }
});

/** BÚSQUEDA MIXTA simple */
app.get('/buscar', async (req, res, next) => {
  try {
    const texto = String(req.query.texto || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10',10),1),50);
    const rx = i18nLike_chat(texto);

    const resp = [];
    if (texto) {
      const salones = await Salon.find({ $or: [{ numero: rx }, { nombre: rx }, { edificio: rx }, { piso: rx }] })
        .sort({ numero: 1 }).limit(limit).lean();
      resp.push(...salones.map(s => ({ tipo: 'salon', ...s })));

      const labs = await Laboratorio.find({ $or: [{ nombre: rx }, { codigo: rx }, { edificio: rx }, { piso: rx }] })
        .sort({ nombre: 1 }).limit(limit).lean();
      resp.push(...labs.map(l => ({ tipo: 'laboratorio', ...l })));
    }

    res.json({ total: resp.length, data: resp.slice(0, limit) });
  } catch (e) { next(e); }
});

// =========================================================
// Endpoint POST /chat
// Implementa búsqueda inteligente con PLN y sinónimos
// Retorna resultados con texto y tarjetas enriquecidas
// =========================================================
app.post('/chat', async (req, res, next) => {
  try {
    const { text = '' } = req.body || {};
    const q = String(text).trim();
    if (!q) return res.status(400).json({ error: 'Falta "text"' });

    // Detección simple del tipo por palabras clave
    const norm = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    let tipo = null; // 'salon' | 'laboratorio' | null (mixto)
    if (/\b(aula|salon|salón|salones)\b/.test(norm)) tipo = 'salon';
    if (/\b(lab|laboratorio|laboratorios)\b/.test(norm)) tipo = tipo || 'laboratorio';
    if (!tipo && /^\s*\d{2,4}\s*$/.test(q)) {
    tipo = 'salon';
  }

    const resultados = [];
    const limit = 5;

    /* ========= SALONES (mejorado) ========= */
    if (!tipo || tipo === 'salon') {
      const resultadosSalones = [];
      const usadosS = new Set();

      // -1) Canon por sinónimos
      const canonSalon = detectCanonicalSalon(q);
      if (canonSalon) {
        const rxCanon = i18nExactRegex_chat(canonSalon);
        const docs = await Salon.find({ nombre: rxCanon })
          .collation({ locale: 'es', strength: 1 }).limit(limit).lean();
        for (const s of docs) {
          const id = String(s._id);
          if (!usadosS.has(id)) { usadosS.add(id); resultadosSalones.push({ tipo: 'salon', ...s }); }
        }
      }

      // 0) L### (Aula/Salón L320, etc.)
      if (resultadosSalones.length < limit) {
        const lcodeSalon = lCodeFrom(q);
        if (lcodeSalon) {
          const variants = lVariants(lcodeSalon);
          let docs = await Salon.find({ nombre: { $in: variants } })
            .collation({ locale: 'es', strength: 1 }).lean();

          if (!docs.length) {
            const num = lcodeSalon.slice(1);
            const rxL = new RegExp(`\\bL\\s*-?\\s*${num}\\b`, 'i');
            docs = await Salon.find({ $or: [{ nombre: rxL }, { numero: rxL }] })
              .limit(limit).lean();
          }
          for (const s of docs) {
            const id = String(s._id);
            if (!usadosS.has(id)) { usadosS.add(id); resultadosSalones.push({ tipo: 'salon', ...s }); }
          }
        }
      }

      // 1) Número suelto (ej. “126”)
      if (resultadosSalones.length < limit) {
        const numSolo = (q.match(/\b(\d{2,4})\b/) || [])[1];
        if (numSolo) {
          const rxNumWord = new RegExp(`\\b${rxEscapeChat(numSolo)}\\b`, 'i');
          const docs = await Salon.find({
            $or: [
              { numero: i18nLike_chat(numSolo) },
              { nombre: rxNumWord }
            ]
          })
          .sort({ numero: 1, nombre: 1 })
          .limit(limit - resultadosSalones.length)
          .lean();

          for (const s of docs) {
            const id = String(s._id);
            if (!usadosS.has(id)) { usadosS.add(id); resultadosSalones.push({ tipo: 'salon', ...s }); }
          }
        }
      }

      // 2) i18n general + “Aula→Salón”
      if (resultadosSalones.length < limit) {
        const restantes = limit - resultadosSalones.length;
        const rxQ = i18nLike_chat(q);
        const qSalonizado = q.replace(/\baula\b/ig, 'Salón').replace(/\bsalon\b/ig,'Salón');
        const rxQSalon = i18nLike_chat(qSalonizado);
        const rxTrimInicio = new RegExp(`^\\s*${rxEscapeChat(q.replace(/\s+/g,' ').trim())}`, 'i');

        const salones = await Salon.find({
          $or: [
            { numero: rxQ },
            { nombre: rxQ },
            { nombre: rxQSalon },
            { edificio: rxQ },
            { piso: rxQ },
            { nombre: rxTrimInicio }
          ]
        })
        .sort({ numero: 1, nombre: 1 })
        .limit(restantes)
        .lean();

        for (const s of salones) {
          const id = String(s._id);
          if (!usadosS.has(id)) { usadosS.add(id); resultadosSalones.push({ tipo: 'salon', ...s }); }
        }
      }

      resultados.push(...resultadosSalones);
    }

    /* ========= LABORATORIOS (con soporte L###) ========= */
    if (!tipo || tipo === 'laboratorio') {
      const resultadosLabs = [];
      const usados = new Set();

      // 0) Canon por sinónimos + normalizador
      const canonLab = detectCanonicalLab(q) || applySynonyms_chat(q);
      if (canonLab) {
        const rxCanon = i18nExactRegex_chat(canonLab);
        const prim = await Laboratorio.find({
          $or: [{ nombre: rxCanon }, { codigo: rxCanon }]
        }).sort({ nombre: 1 }).limit(limit).lean();
        for (const l of prim) {
          if (!usados.has(String(l._id))) {
            usados.add(String(l._id));
            resultadosLabs.push({ tipo: 'laboratorio', ...l });
          }
        }
      }

      // 1) L### como código o dentro del nombre
      if (resultadosLabs.length < limit) {
        const mLabL = q.match(/\b[Ll]\s*-?\s*(\d{3})\b/);
        if (mLabL) {
          const num = mLabL[1];
          const rxL = new RegExp(`\\bL\\s*-?\\s*${num}\\b`, 'i');

          const labsByCodeOrName = await Laboratorio.find({
            $or: [{ codigo: rxL }, { nombre: rxL }]
          }).sort({ nombre: 1 }).limit(limit - resultadosLabs.length).lean();

          for (const l of labsByCodeOrName) {
            if (!usados.has(String(l._id))) {
              usados.add(String(l._id));
              resultadosLabs.push({ tipo: 'laboratorio', ...l });
            }
          }
        }
      }

      // 2) Búsqueda i18n general (rellena)
      if (resultadosLabs.length < limit) {
        const rx = i18nLike_chat(q);
        const labs = await Laboratorio.find({
          $or: [{ nombre: rx }, { codigo: rx }, { edificio: rx }, { piso: rx }]
        })
        .sort({ nombre: 1 })
        .limit(limit - resultadosLabs.length)
        .lean();

        for (const l of labs) {
          if (!usados.has(String(l._id))) {
            usados.add(String(l._id));
            resultadosLabs.push({ tipo: 'laboratorio', ...l });
          }
        }
      }

      resultados.push(...resultadosLabs);
    }

    // Si no hubo resultados:
    if (!resultados.length) {
      return res.json({ messages: [{ role: 'bot', text: 'No encontré coincidencias para tu consulta.' }] });
    }

    // ===== helper: transformar links (Drive → directo) =====
    function toDirectImage(url = '') {
      if (!url) return '';
      if (url.startsWith('local:')) return `http://localhost:3000/mapas/${url.slice('local:'.length)}`;
      if (url.startsWith('mapas/'))  return `http://localhost:3000/${url}`;
      const m = String(url).match(/https:\/\/drive\.google\.com\/file\/d\/([^/]+)/i);
      if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
      return url;
    }

    // ===== builders de tarjetas con imagen + info (sin botón) =====
    function buildSalonCard(x) {
      const titulo   = x.nombre || x.numero || "Salón";
      const edificio = x.edificio  || "Edificio s/d";
      const piso     = x.piso      || "Piso s/d";
      const ubic     = x.ubicacion || "s/d";
      const imgUrl   = pickBuildingImage(x);

      const card = [];
      if (imgUrl) card.push({ type: "image", rawUrl: imgUrl, accessibilityText: titulo });
      card.push({
        type: "info",
        title: `Nombre: ${titulo}`,
        subtitle: `Edificio: ${edificio}\nPiso: ${piso}\nUbicación: ${ubic}`
      });
      return card;
    }

    function buildLabCard(x) {
      const titulo   = x.nombre || x.codigo || "Laboratorio";
      const edificio = x.edificio  || "Edificio s/d";
      const piso     = x.piso      || "Piso s/d";
      const ubic     = x.ubicacion || "s/d";
      const imgUrl   = pickBuildingImage(x);

      const card = [];
      if (imgUrl) card.push({ type: "image", rawUrl: imgUrl, accessibilityText: titulo });
      card.push({
        type: "info",
        title: `Nombre: ${titulo}`,
        subtitle: `Edificio: ${edificio}\nPiso: ${piso}\nUbicación: ${ubic}`
      });
      return card;
    }

    // (opcional) texto plano arriba
    const textoPlano = [
      `Encontré ${resultados.length} resultado(s):`,
      ...resultados.map(x => {
        const nombre = x.nombre || x.codigo || (x.tipo === "salon" ? "Salón" : "Laboratorio");
        const ed     = x.edificio || "Edificio s/d";
        const ps     = x.piso     || "Piso s/d";
        const ubi    = x.ubicacion ? `, ${x.ubicacion}` : "";
        return `${nombre}`;
      })
    ].join("\n");

    // Armar richContent (imagen + info, sin botón)
    const richContent = [[]];
    resultados.slice(0, 5).forEach(x => {
      richContent[0].push(...(x.tipo === "salon" ? buildSalonCard(x) : buildLabCard(x)));
    });

    return res.json({
      messages: [
        { role: "bot", text: textoPlano },
        { role: "bot", payload: { richContent } }
      ]
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================
// Endpoint POST /chat/df
// Integración con Dialogflow para análisis de intención
// Usa credenciales de Google Cloud y devuelve mensajes enriquecidos
// =========================================================
const { v4: uuidv4 } = require('uuid');

let DialogflowSessionsClient = null;
try {
  DialogflowSessionsClient = require('@google-cloud/dialogflow').SessionsClient;
} catch (e) {
  console.warn('⚠ Falta @google-cloud/dialogflow. Instala con: npm i @google-cloud/dialogflow');
}

app.post('/chat/df', async (req, res) => {
  try {
    if (!DialogflowSessionsClient) {
      return res.status(500).json({ error: 'Dialogflow client no disponible' });
    }

    const { text = '', sessionId } = req.body || {};
    const clean = String(text || '').trim();
    if (!clean) return res.status(400).json({ error: 'Falta "text"' });

    const projectId    = process.env.DIALOGFLOW_PROJECT_ID;
    const languageCode = process.env.DIALOGFLOW_LANGUAGE_CODE || 'es';
    if (!projectId) {
      return res.status(500).json({ error: 'Falta DIALOGFLOW_PROJECT_ID en .env' });
    }

    const client      = new DialogflowSessionsClient(); // requiere GOOGLE_APPLICATION_CREDENTIALS
    const sid         = sessionId || uuidv4();
    const sessionPath = client.projectAgentSessionPath(projectId, sid);

    const request = { session: sessionPath, queryInput: { text: { text: clean, languageCode } } };
    const [response] = await client.detectIntent(request);

    const qr          = response?.queryResult || {};
    const intentName  = qr.intent?.displayName || '';
    const confidence  = Number(qr.intentDetectionConfidence ?? 0);
    const fText       = qr.fulfillmentText || '';
    const fMsgs       = qr.fulfillmentMessages || [];

    const isFallback  = intentName === 'Default Fallback Intent' || confidence < 0.55;

    const messages = [];
    if (fText) messages.push({ role: 'bot', text: fText });

    const toJs = (any) => {
      if (!any) return null;
      if (any.listValue)  return any.listValue.values.map(toJs);
      if (any.structValue){
        const obj = {};
        for (const [k,v] of Object.entries(any.structValue.fields || {})) obj[k] = toJs(v);
        return obj;
      }
      if ('stringValue' in any) return any.stringValue;
      if ('numberValue' in any) return any.numberValue;
      if ('boolValue'   in any) return any.boolValue;
      return null;
    };

    for (const m of fMsgs) {
      if (m?.payload?.fields?.richContent) {
        const richContent = toJs(m.payload.fields.richContent);
        if (richContent) messages.push({ role: 'bot', payload: { richContent } });
      }
    }

    if (!messages.length) messages.push({ role: 'bot', text: '¿Disculpa?' });

    return res.json({
      sessionId: sid,
      intentDisplay: intentName,
      confidence,
      isFallback,
      messages
    });

  } catch (err) {
    console.error('Error /chat/df:', err.message);
    return res.status(500).json({ error: 'Error detectIntent', details: err.message });
  }
});

// =========================================================
// Manejo de errores y arranque del servidor
// Controla errores 404/500 y lanza el servicio HTTP
// =========================================================
app.use((req, res) => res.status(404).json({ error: 'Recurso no encontrado' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
});

app.listen(PORT, HOST, () => {
  console.log(`API escuchando en http://${HOST}:${PORT}`);
});