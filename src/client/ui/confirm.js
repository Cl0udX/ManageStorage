// Confirmación escrita para acciones peligrosas (Anular, Quitar): la persona debe escribir la palabra a mano.
// Evita anular o quitar algo por un toque accidental.
export const CONFIRM_WORD = 'confirmar';

const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** Acepta mayúsculas/minúsculas, tildes y espacios de más: "Confirmar", " confírmar " … */
export const isConfirmation = (text) => norm(text) === CONFIRM_WORD;
