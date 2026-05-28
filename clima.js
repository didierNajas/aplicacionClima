/**
 * clima.js — Aplicación del clima usando Open-Meteo API
 *
 * LICENCIAMIENTO:
 * - Open-Meteo API: CC BY 4.0 (https://open-meteo.com/en/terms)
 *   Compatible con uso comercial. Se requiere atribución.
 * - Open-Meteo Geocoding API: CC BY 4.0 (misma licencia)
 *
 * SEGURIDAD:
 * - Esta app NO usa API keys (Open-Meteo es pública y gratuita).
 * - Si en el futuro se agrega una API con key, NUNCA hardcodear la key aquí.
 *   Usar un backend proxy que lea process.env.API_KEY en el servidor.
 * - Los datos de ubicación del usuario se usan solo en memoria durante la sesión.
 * - No se almacenan datos personales en localStorage (solo datos meteorológicos
 *   anónimos de ciudades, sin vincular a usuarios).
 *
 * PRIVACIDAD (GDPR / Ley 1581 Colombia / LGPD Brasil):
 * - La geolocalización del navegador (navigator.geolocation) requiere
 *   consentimiento explícito del usuario antes de solicitarse.
 * - No se recopilan ni transmiten datos personales identificables.
 * - El caché en localStorage almacena únicamente datos meteorológicos
 *   públicos indexados por nombre de ciudad (no por usuario).
 */

"use strict";

// ─── Constantes de configuración ────────────────────────────────────────────

const CACHE_KEY = "climaOpenMeteoCache";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
const REQUEST_TIMEOUT_MS = 10_000;    // 10 segundos

// Límite de ciudades por consulta para evitar abuso de la API
const MAX_CITIES_PER_REQUEST = 10;

// Longitud máxima del input para prevenir ataques de payload largo
const MAX_INPUT_LENGTH = 500;

// URLs base de la API — definidas como constantes, nunca interpoladas con datos de usuario sin sanitizar
const GEOCODING_API_BASE = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_API_BASE = "https://api.open-meteo.com/v1/forecast";

// ─── Caché ───────────────────────────────────────────────────────────────────

let inMemoryCache = {};

function localStorageAvailable() {
    try {
        const testKey = "__cache_test__";
        window.localStorage.setItem(testKey, testKey);
        window.localStorage.removeItem(testKey);
        return true;
    } catch {
        return false;
    }
}

function loadCache() {
    if (localStorageAvailable()) {
        try {
            return JSON.parse(window.localStorage.getItem(CACHE_KEY) || "{}") || {};
        } catch {
            return {};
        }
    }
    return inMemoryCache;
}

function saveCache(cache) {
    if (localStorageAvailable()) {
        try {
            window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch {
            // Si localStorage falla, solo actualizamos memoria
        }
    } else {
        inMemoryCache = cache;
    }
}

/**
 * Normaliza el nombre de ciudad para usar como clave de caché.
 * Solo letras, números, espacios y guiones — previene inyección de claves.
 */
function getCacheKey(city) {
    return city.trim().toLowerCase().replace(/[^a-záéíóúüñ0-9\s-]/gi, "");
}

function getCachedWeather(city) {
    const cache = loadCache();
    const key = getCacheKey(city);
    const entry = cache[key];

    if (!entry) return null;

    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        delete cache[key];
        saveCache(cache);
        return null;
    }

    return entry.data;
}

function setCachedWeather(city, data) {
    const cache = loadCache();
    const key = getCacheKey(city);
    cache[key] = { timestamp: Date.now(), data };
    saveCache(cache);
}

// ─── Validación de entrada ───────────────────────────────────────────────────

/**
 * Sanitiza y valida el nombre de una ciudad.
 * Previene XSS al rechazar caracteres HTML/script antes de cualquier uso.
 * @param {string} city
 * @returns {string} ciudad sanitizada
 * @throws {Error} si el input es inválido
 */
function sanitizeCityName(city) {
    if (typeof city !== "string") {
        throw new Error("El nombre de ciudad debe ser texto.");
    }

    const trimmed = city.trim();

    if (trimmed.length === 0) {
        throw new Error("Por favor ingresa un nombre de ciudad válido.");
    }

    if (trimmed.length > 100) {
        throw new Error("El nombre de ciudad es demasiado largo.");
    }

    // Rechazar caracteres HTML para prevenir XSS al renderizar en el DOM
    if (/[<>"'`]/.test(trimmed)) {
        throw new Error("El nombre de ciudad contiene caracteres no permitidos.");
    }

    return trimmed;
}

/**
 * Parsea y valida la lista de ciudades del input del usuario.
 * @param {string} input
 * @returns {string[]}
 */
function parseCities(input) {
    if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) {
        throw new Error(`El input no puede superar ${MAX_INPUT_LENGTH} caracteres.`);
    }

    const cities = input
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

    if (cities.length === 0) {
        throw new Error("Por favor escribe el nombre de al menos una ciudad.");
    }

    if (cities.length > MAX_CITIES_PER_REQUEST) {
        throw new Error(`Puedes consultar hasta ${MAX_CITIES_PER_REQUEST} ciudades a la vez.`);
    }

    // Validar cada ciudad individualmente
    return cities.map(sanitizeCityName);
}

// ─── HTTP con timeout ────────────────────────────────────────────────────────

/**
 * Realiza una petición fetch con timeout y manejo de errores HTTP.
 * Solo acepta URLs HTTPS para prevenir ataques de downgrade.
 * @param {string} url - Debe ser HTTPS
 * @param {object} options
 * @returns {Promise<object>}
 */
async function fetchJsonWithTimeout(url, options = {}) {
    // Forzar HTTPS — nunca hacer peticiones a HTTP en producción
    if (!url.startsWith("https://")) {
        throw new Error("Solo se permiten peticiones HTTPS.");
    }

    const controller = new AbortController();
    const timeoutMs = options.timeout || REQUEST_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });

        if (!response.ok) {
            if (response.status === 429) {
                throw new Error("Se alcanzó el límite de solicitudes. Intenta más tarde.");
            }
            if (response.status >= 500) {
                throw new Error("El servidor de clima no está disponible. Intenta más tarde.");
            }
            throw new Error(`Error HTTP ${response.status} al consultar la API.`);
        }

        // Validar Content-Type para prevenir parsing de respuestas inesperadas
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            throw new Error("La API devolvió una respuesta inesperada.");
        }

        return await response.json();
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("La petición tardó demasiado. Revisa tu conexión.");
        }
        if (error instanceof TypeError) {
            throw new Error("No se pudo conectar con la API. Revisa tu conexión.");
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ─── Geolocalización con consentimiento explícito ────────────────────────────

/**
 * Solicita la ubicación del navegador con consentimiento explícito del usuario.
 * Cumple con GDPR Art. 7 y Ley 1581 (Colombia) — el consentimiento debe ser
 * libre, específico, informado e inequívoco.
 *
 * NOTA: Esta función solo se llama si el usuario hace clic en "Usar mi ubicación".
 * Nunca se llama automáticamente al cargar la página.
 *
 * @returns {Promise<{latitude: number, longitude: number}>}
 */
function obtenerUbicacionNavegador() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Tu navegador no soporta geolocalización."));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                resolve({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                });
            },
            (error) => {
                const mensajes = {
                    1: "Permiso de ubicación denegado.",
                    2: "No se pudo obtener la ubicación.",
                    3: "La solicitud de ubicación tardó demasiado.",
                };
                reject(new Error(mensajes[error.code] || "Error de geolocalización."));
            },
            { timeout: 10000, maximumAge: 300000 }
        );
    });
}

// ─── Lógica de negocio ───────────────────────────────────────────────────────

async function obtenerUbicacion(ciudad) {
    const ciudadSanitizada = sanitizeCityName(ciudad);

    // encodeURIComponent previene inyección en la URL
    const url = `${GEOCODING_API_BASE}?name=${encodeURIComponent(ciudadSanitizada)}&count=1&language=es&format=json`;
    const data = await fetchJsonWithTimeout(url);

    if (!data.results || data.results.length === 0) {
        throw new Error("Ciudad no encontrada. Intenta con otro nombre.");
    }

    const location = data.results[0];

    if (location.latitude == null || location.longitude == null) {
        throw new Error("La API de geocodificación no devolvió coordenadas válidas.");
    }

    // Sanitizar datos de la API antes de usarlos en el DOM
    const resolvedLocation = [location.name, location.admin1, location.country]
        .filter(Boolean)
        .map(escapeHtml)
        .join(", ");

    return {
        ciudad: escapeHtml(String(location.name || "")),
        resolved_location: resolvedLocation,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
    };
}

function findHourlyIndexForTime(currentTime, hourly) {
    const times = hourly?.time || [];
    if (!times.length) return -1;

    const exactIndex = times.indexOf(currentTime);
    if (exactIndex !== -1) return exactIndex;

    const currentTimestamp = Date.parse(currentTime);
    if (Number.isNaN(currentTimestamp)) return -1;

    return times.findIndex((hourTime) => Date.parse(hourTime) === currentTimestamp);
}

async function obtenerClimaActual(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error("Coordenadas inválidas.");
    }

    const url = `${WEATHER_API_BASE}?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m,precipitation&temperature_unit=celsius&windspeed_unit=kmh&precipitation_unit=mm&timezone=auto`;
    const data = await fetchJsonWithTimeout(url);

    if (!data.current_weather) {
        throw new Error("No se pudo obtener el clima actual.");
    }

    const currentTime = data.current_weather.time;
    const currentIndex = findHourlyIndexForTime(currentTime, data.hourly);
    const humidityValue = currentIndex !== -1 ? data.hourly.relativehumidity_2m?.[currentIndex] ?? null : null;
    const precipitationValue = currentIndex !== -1 ? data.hourly.precipitation?.[currentIndex] ?? null : null;

    return {
        temperature_celsius: data.current_weather.temperature,
        wind_speed_kmh: data.current_weather.windspeed,
        weather_code: data.current_weather.weathercode,
        humidity_percent: humidityValue,
        precipitation_mm: precipitationValue,
        time: currentTime,
        timezone: data.timezone,
    };
}

async function obtenerPronostico5Dias(ciudad) {
    const ubicacion = await obtenerUbicacion(ciudad);
    const lat = Number(ubicacion.latitude);
    const lon = Number(ubicacion.longitude);

    const url = `${WEATHER_API_BASE}?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&temperature_unit=celsius&windspeed_unit=kmh&precipitation_unit=mm&forecast_days=5&timezone=auto`;
    const data = await fetchJsonWithTimeout(url);

    if (!data.daily || !data.daily.time) {
        throw new Error("No se pudo obtener el pronóstico de 5 días.");
    }

    const forecast = data.daily.time.map((date, index) => ({
        date,
        weather_code: data.daily.weathercode?.[index],
        description: obtenerDescripcionClima(data.daily.weathercode?.[index]),
        temp_max: data.daily.temperature_2m_max?.[index],
        temp_min: data.daily.temperature_2m_min?.[index],
        precipitation_mm: data.daily.precipitation_sum?.[index],
    }));

    return {
        ciudad: ubicacion.ciudad,
        resolved_location: ubicacion.resolved_location,
        forecast,
    };
}

async function obtenerClimaPorCiudad(ciudad) {
    const normalizedCity = sanitizeCityName(ciudad);
    const cached = getCachedWeather(normalizedCity);

    if (cached) {
        return { ...cached, cached: true };
    }

    const ubicacion = await obtenerUbicacion(normalizedCity);
    const climaActual = await obtenerClimaActual(ubicacion.latitude, ubicacion.longitude);

    const resultado = {
        ciudad: normalizedCity,
        resolved_location: ubicacion.resolved_location,
        ...climaActual,
    };

    setCachedWeather(normalizedCity, resultado);
    return resultado;
}

async function obtenerClimaMultiples(ciudades) {
    return Promise.all(
        ciudades.map(async (ciudad) => {
            try {
                return await obtenerClimaPorCiudad(ciudad);
            } catch (error) {
                return {
                    ciudad: escapeHtml(ciudad),
                    error: true,
                    mensaje: error.message,
                };
            }
        })
    );
}

// ─── Utilidades de presentación ──────────────────────────────────────────────

/**
 * Escapa caracteres HTML para prevenir XSS al insertar datos en el DOM.
 * Usar siempre que se inserte texto de fuentes externas (API, input usuario).
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (typeof str !== "string") return String(str ?? "");
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function obtenerDescripcionClima(codigo) {
    const descripciones = {
        0: "Cielo despejado",
        1: "Principalmente despejado",
        2: "Parcialmente nublado",
        3: "Nublado",
        45: "Niebla",
        48: "Niebla con escarcha",
        51: "Llovizna ligera",
        53: "Llovizna moderada",
        55: "Llovizna intensa",
        61: "Lluvia ligera",
        63: "Lluvia moderada",
        65: "Lluvia fuerte",
        71: "Nevada ligera",
        73: "Nevada moderada",
        75: "Nevada intensa",
        80: "Chubascos ligeros",
        81: "Chubascos moderados",
        82: "Chubascos fuertes",
        95: "Tormenta",
        96: "Tormenta con granizo ligero",
        99: "Tormenta con granizo fuerte",
    };
    return descripciones[codigo] || "Clima desconocido";
}

function obtenerIconoClima(codigo) {
    const iconos = {
        0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
        45: "🌫️", 48: "🌫️",
        51: "🌦️", 53: "🌧️", 55: "🌧️",
        61: "🌧️", 63: "🌧️", 65: "⛈️",
        71: "❄️", 73: "❄️", 75: "❄️",
        80: "🌦️", 81: "🌧️", 82: "⛈️",
        95: "⛈️", 96: "⛈️", 99: "⛈️",
    };
    return iconos[codigo] || "🌈";
}

function formatearFecha(fecha) {
    try {
        return new Intl.DateTimeFormat("es-ES", {
            weekday: "short",
            day: "numeric",
            month: "short",
        }).format(new Date(fecha));
    } catch {
        return escapeHtml(fecha);
    }
}

function formatNumber(value, suffix = "") {
    return value == null ? "—" : `${value}${suffix}`;
}

// ─── Renderizado DOM (sin innerHTML con datos sin sanitizar) ─────────────────

function mostrarMensaje(texto, tipo = "info") {
    const mensaje = document.getElementById("mensaje");
    mensaje.classList.remove("hidden");
    // textContent en lugar de innerHTML para el texto del usuario — previene XSS
    const p = document.createElement("p");
    p.textContent = texto;
    mensaje.innerHTML = "";
    mensaje.appendChild(p);
    mensaje.style.borderColor = tipo === "error"
        ? "rgba(239, 68, 68, 0.25)"
        : "rgba(59, 130, 246, 0.16)";
    mensaje.style.backgroundColor = tipo === "error" ? "#f8d7da" : "#eef2ff";
}

function ocultarMensaje() {
    const mensaje = document.getElementById("mensaje");
    mensaje.classList.add("hidden");
    mensaje.innerHTML = "";
}

/**
 * Crea un elemento de tarjeta de clima usando createElement (no innerHTML con datos externos).
 * Esto previene XSS incluso si la API devuelve datos maliciosos.
 */
function crearTarjetaClima(resultado) {
    const article = document.createElement("article");
    article.className = "weather-card";

    if (resultado.error) {
        article.innerHTML = `
            <header>
                <h2></h2>
                <span>❌ Error</span>
            </header>
            <p></p>
        `;
        article.querySelector("h2").textContent = resultado.ciudad;
        article.querySelector("p").textContent = resultado.mensaje;
        return article;
    }

    // Usar textContent para todos los datos provenientes de la API
    const header = document.createElement("header");

    const infoDiv = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = resultado.resolved_location;
    const cityLabel = document.createElement("p");
    cityLabel.className = "label";
    cityLabel.textContent = resultado.ciudad;
    infoDiv.appendChild(h2);
    infoDiv.appendChild(cityLabel);

    const iconDiv = document.createElement("div");
    iconDiv.className = "icono-clima";
    iconDiv.textContent = obtenerIconoClima(resultado.weather_code);

    header.appendChild(infoDiv);
    header.appendChild(iconDiv);
    article.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "weather-meta";

    const stats = [
        ["Temperatura", formatNumber(resultado.temperature_celsius, "°C")],
        ["Clima", obtenerDescripcionClima(resultado.weather_code)],
        ["Humedad", formatNumber(resultado.humidity_percent, "%")],
        ["Viento", formatNumber(resultado.wind_speed_kmh, " km/h")],
        ["Precipitación", formatNumber(resultado.precipitation_mm, " mm")],
        ["Actualizado", resultado.time || "—"],
        ...(resultado.cached ? [["Caché", "Datos recientes"]] : []),
    ];

    stats.forEach(([label, value]) => {
        const row = document.createElement("div");
        row.className = "stat-row";
        const labelSpan = document.createElement("span");
        labelSpan.className = "label";
        labelSpan.textContent = label;
        const valueSpan = document.createElement("span");
        valueSpan.className = "value";
        valueSpan.textContent = value;
        row.appendChild(labelSpan);
        row.appendChild(valueSpan);
        meta.appendChild(row);
    });

    article.appendChild(meta);
    return article;
}

function mostrarClimaComparativo(resultados) {
    const contenedor = document.getElementById("resultado");
    contenedor.innerHTML = "";

    const titulo = document.createElement("div");
    titulo.className = "weather-card";
    const h2 = document.createElement("h2");
    h2.textContent = "Clima actual comparativo";
    titulo.appendChild(h2);
    contenedor.appendChild(titulo);

    resultados.forEach((resultado) => {
        contenedor.appendChild(crearTarjetaClima(resultado));
    });

    contenedor.classList.remove("hidden");
}

function mostrarPronostico5Dias(resultadoPronostico) {
    const contenedor = document.getElementById("forecast");

    if (!resultadoPronostico || !resultadoPronostico.forecast) {
        contenedor.classList.add("hidden");
        contenedor.innerHTML = "";
        return;
    }

    contenedor.innerHTML = "";
    const section = document.createElement("div");
    section.className = "forecast-section";

    const h2 = document.createElement("h2");
    h2.textContent = `Pronóstico de 5 días para ${resultadoPronostico.resolved_location}`;
    section.appendChild(h2);

    const grid = document.createElement("div");
    grid.className = "forecast-grid";

    resultadoPronostico.forecast.forEach((dia) => {
        const card = document.createElement("article");
        card.className = "forecast-card";

        const h3 = document.createElement("h3");
        h3.textContent = formatearFecha(dia.date);
        card.appendChild(h3);

        const desc = document.createElement("p");
        desc.textContent = `${obtenerIconoClima(dia.weather_code)} ${dia.description}`;
        card.appendChild(desc);

        [
            ["Máx:", formatNumber(dia.temp_max, "°C")],
            ["Mín:", formatNumber(dia.temp_min, "°C")],
            ["Lluvia:", formatNumber(dia.precipitation_mm, " mm")],
        ].forEach(([label, value]) => {
            const p = document.createElement("p");
            p.className = "label";
            p.textContent = `${label} `;
            const span = document.createElement("span");
            span.className = "value";
            span.textContent = value;
            p.appendChild(span);
            card.appendChild(p);
        });

        grid.appendChild(card);
    });

    section.appendChild(grid);
    contenedor.appendChild(section);
    contenedor.classList.remove("hidden");
}

function limpiarResultados() {
    const resultado = document.getElementById("resultado");
    const forecast = document.getElementById("forecast");
    resultado.classList.add("hidden");
    resultado.innerHTML = "";
    forecast.classList.add("hidden");
    forecast.innerHTML = "";
    ocultarMensaje();
}

function mostrarCarga(ciudades) {
    const texto = ciudades.length > 1
        ? `Buscando clima para ${ciudades.length} ciudades...`
        : `Buscando clima para ${ciudades[0]}...`;
    mostrarMensaje(texto);
}

// ─── Consentimiento de geolocalización ──────────────────────────────────────

/**
 * Muestra un banner de consentimiento antes de solicitar la ubicación.
 * Cumple con el principio de consentimiento previo e informado (GDPR Art. 7).
 * @returns {Promise<boolean>} true si el usuario acepta
 */
function solicitarConsentimientoUbicacion() {
    return new Promise((resolve) => {
        const banner = document.getElementById("consent-banner");
        if (!banner) {
            // Si no existe el banner en el HTML, resolver como false (no consentido)
            resolve(false);
            return;
        }

        banner.classList.remove("hidden");

        const btnAceptar = document.getElementById("consent-accept");
        const btnRechazar = document.getElementById("consent-reject");

        const onAceptar = () => {
            banner.classList.add("hidden");
            cleanup();
            resolve(true);
        };

        const onRechazar = () => {
            banner.classList.add("hidden");
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            btnAceptar?.removeEventListener("click", onAceptar);
            btnRechazar?.removeEventListener("click", onRechazar);
        };

        btnAceptar?.addEventListener("click", onAceptar);
        btnRechazar?.addEventListener("click", onRechazar);
    });
}

// ─── Inicialización ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("clima-form");
    const input = document.getElementById("ciudad-input");
    const forecastCheckbox = document.getElementById("forecast-checkbox");
    const locationBtn = document.getElementById("location-btn");

    // Botón de geolocalización — solo actúa con consentimiento explícito
    if (locationBtn) {
        locationBtn.addEventListener("click", async () => {
            const consentido = await solicitarConsentimientoUbicacion();
            if (!consentido) {
                mostrarMensaje("Permiso de ubicación no otorgado.", "info");
                return;
            }

            try {
                mostrarMensaje("Obteniendo tu ubicación...");
                const { latitude, longitude } = await obtenerUbicacionNavegador();
                // Usar coordenadas directamente sin almacenarlas
                const climaActual = await obtenerClimaActual(latitude, longitude);
                mostrarClimaComparativo([{
                    ciudad: "Tu ubicación",
                    resolved_location: "Ubicación actual",
                    ...climaActual,
                }]);
            } catch (error) {
                mostrarMensaje(error.message, "error");
            }
        });
    }

    form.addEventListener("submit", async (evento) => {
        evento.preventDefault();

        const texto = input.value;
        limpiarResultados();

        let ciudades;
        try {
            ciudades = parseCities(texto);
        } catch (error) {
            mostrarMensaje(error.message, "error");
            return;
        }

        mostrarCarga(ciudades);

        try {
            const resultados = await obtenerClimaMultiples(ciudades);
            mostrarClimaComparativo(resultados);

            if (forecastCheckbox.checked) {
                const pronostico = await obtenerPronostico5Dias(ciudades[0]);
                mostrarPronostico5Dias(pronostico);
                if (ciudades.length > 1) {
                    mostrarMensaje("Pronóstico de 5 días mostrado para la primera ciudad ingresada.");
                }
            }
        } catch (error) {
            mostrarMensaje(error.message || "Ocurrió un error inesperado.", "error");
        }
    });
});
