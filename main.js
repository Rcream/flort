// ============================================================
// Flort — Floor Plan Maker (main.js)
// Pure vanilla JS — no frameworks or libraries
// ============================================================


// ----- Constants ---------------------------------------------------

const GRID = 20;            // One grid square = 20 pixels
const METERS_PER_GRID = 0.5; // 20 px represents 0.5 metres
const WALL_THICK = 4;       // Wall line width (px)
const DOOR_SIZE = 10;       // Door marker radius (px)
const WIN_W = 14;           // Window marker width (px)
const WIN_H = 4;            // Window marker height (px)
const HIT_DIST = 8;         // Max pixel distance for a wall hit-test


// ----- Colours (dark theme) ----------------------------------------

const COL = {
    canvasBg:     '#14141c',
    grid:         '#1c1c28',
    gridMajor:    '#252534',
    room:         'rgba(30, 60, 90, 0.5)',
    roomBorder:   '#4a9eff',
    roomLabel:    '#8ac4ff',
    wall:         '#78828e',
    door:         '#ff6b4a',
    window:       '#4affb8',
    furniture:    'rgba(70, 50, 100, 0.5)',
    furnBorder:   '#9b7aff',
    furnLabel:    '#c4aaff',
    selected:     '#00d4aa',
    preview:      'rgba(0, 212, 170, 0.25)',
    previewLine:  '#00d4aa',
};


// ----- Application state -------------------------------------------

let objects    = [];     // All placed floor-plan objects
let tool       = 'select'; // Current tool name
let selected   = null;   // The object currently selected (or null)
let dragging   = false;  // True while the user drags with Select tool
let dragOffset = { x: 0, y: 0 }; // Mouse-to-object offset during drag
let placeStart = null;   // Grid-snapped start point while drawing
let preview    = null;   // Temporary preview object shown while dragging


// ----- Canvas setup ------------------------------------------------

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// Resize the canvas to fill the space below the toolbar
function resizeCanvas() {
    canvas.width  = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    render();
}


// ----- Helpers -----------------------------------------------------

// Snap a pixel coordinate to the nearest grid line
function snap(v) {
    return Math.round(v / GRID) * GRID;
}

// Convert a pixel distance to metres for display (e.g. "3.0")
function pxToM(px) {
    return ((px / GRID) * METERS_PER_GRID).toFixed(1);
}

// Get mouse position relative to the canvas
function getMousePos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}


// ============================================================
// GRID
// ============================================================

function drawGrid() {
    const w = canvas.width;
    const h = canvas.height;

    ctx.lineWidth = 1;

    // Vertical grid lines
    for (let x = 0; x <= w; x += GRID) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
        // Brighter line every 5 squares (every 2.5 m)
        ctx.strokeStyle = (x / GRID) % 5 === 0 ? COL.gridMajor : COL.grid;
        ctx.stroke();
    }

    // Horizontal grid lines
    for (let y = 0; y <= h; y += GRID) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.strokeStyle = (y / GRID) % 5 === 0 ? COL.gridMajor : COL.grid;
        ctx.stroke();
    }
}


// ============================================================
// DRAW OBJECTS
// ============================================================

// -- Room (filled rectangle with dimensions in metres) ----------

function drawRoom(obj, isSel) {
    // Fill
    ctx.fillStyle = isSel ? 'rgba(0,212,170,0.12)' : COL.room;
    ctx.fillRect(obj.x, obj.y, obj.w, obj.h);

    // Border
    ctx.strokeStyle = isSel ? COL.selected : COL.roomBorder;
    ctx.lineWidth   = isSel ? 2 : 1.5;
    ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);

    // Dimension label  (only if the room is big enough to read)
    if (obj.w > 40 && obj.h > 30) {
        const label = pxToM(obj.w) + 'm \u00d7 ' + pxToM(obj.h) + 'm';
        ctx.fillStyle    = isSel ? COL.selected : COL.roomLabel;
        ctx.font         = '12px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, obj.x + obj.w / 2, obj.y + obj.h / 2);
    }
}

// -- Wall (thick line) -------------------------------------------

function drawWall(obj, isSel) {
    ctx.beginPath();
    ctx.moveTo(obj.x, obj.y);
    ctx.lineTo(obj.x2, obj.y2);
    ctx.strokeStyle = isSel ? COL.selected : COL.wall;
    ctx.lineWidth   = isSel ? WALL_THICK + 2 : WALL_THICK;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Length label along the wall
    const len = Math.hypot(obj.x2 - obj.x, obj.y2 - obj.y);
    if (len > 40) {
        const mx = (obj.x + obj.x2) / 2;
        const my = (obj.y + obj.y2) / 2;
        ctx.fillStyle    = isSel ? COL.selected : COL.wall;
        ctx.font         = '11px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(pxToM(len) + 'm', mx, my - 8);
    }
}

// -- Door (small filled arc) ------------------------------------

function drawDoor(obj, isSel) {
    ctx.fillStyle = isSel ? COL.selected : COL.door;
    ctx.beginPath();
    ctx.arc(obj.x, obj.y, DOOR_SIZE, -Math.PI / 2, 0);
    ctx.lineTo(obj.x, obj.y);
    ctx.closePath();
    ctx.fill();
}

// -- Window (small thin rectangle) ------------------------------

function drawWindow(obj, isSel) {
    const hw = WIN_W / 2;
    const hh = WIN_H / 2;
    ctx.fillStyle   = isSel ? COL.selected : COL.window;
    ctx.fillRect(obj.x - hw, obj.y - hh, WIN_W, WIN_H);
    ctx.strokeStyle = isSel ? COL.selected : COL.window;
    ctx.lineWidth   = 1;
    ctx.strokeRect(obj.x - hw, obj.y - hh, WIN_W, WIN_H);
}

// -- Furniture (filled rectangle with label) --------------------

function drawFurniture(obj, isSel) {
    ctx.fillStyle = isSel ? 'rgba(0,212,170,0.12)' : COL.furniture;
    ctx.fillRect(obj.x, obj.y, obj.w, obj.h);

    ctx.strokeStyle = isSel ? COL.selected : COL.furnBorder;
    ctx.lineWidth   = isSel ? 2 : 1.5;
    ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);

    if (obj.w > 24 && obj.h > 18) {
        ctx.fillStyle    = isSel ? COL.selected : COL.furnLabel;
        ctx.font         = '10px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Furniture', obj.x + obj.w / 2, obj.y + obj.h / 2);
    }
}

// -- Preview (dashed outline while dragging) --------------------

function drawPreview() {
    if (!preview) return;

    ctx.save();
    ctx.globalAlpha = 0.7;

    if (preview.type === 'room' || preview.type === 'furniture') {
        ctx.fillStyle   = COL.preview;
        ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
        ctx.strokeStyle = COL.previewLine;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(preview.x, preview.y, preview.w, preview.h);
        ctx.setLineDash([]);

        // Live dimension readout while dragging
        const w = Math.abs(preview.w);
        const h = Math.abs(preview.h);
        if (w > 10 && h > 10) {
            const label = pxToM(w) + 'm \u00d7 ' + pxToM(h) + 'm';
            ctx.fillStyle    = COL.selected;
            ctx.font         = '12px sans-serif';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, preview.x + preview.w / 2, preview.y + preview.h / 2);
        }
    }
    else if (preview.type === 'wall') {
        ctx.beginPath();
        ctx.moveTo(preview.x, preview.y);
        ctx.lineTo(preview.x2, preview.y2);
        ctx.strokeStyle = COL.previewLine;
        ctx.lineWidth   = WALL_THICK;
        ctx.lineCap     = 'round';
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);

        const len = Math.hypot(preview.x2 - preview.x, preview.y2 - preview.y);
        if (len > 20) {
            const mx = (preview.x + preview.x2) / 2;
            const my = (preview.y + preview.y2) / 2;
            ctx.fillStyle    = COL.selected;
            ctx.font         = '11px sans-serif';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(pxToM(len) + 'm', mx, my - 8);
        }
    }

    ctx.restore();
}

// -- Selection handles (small squares at corners) ---------------

function drawSelectionHandles(obj) {
    const corners = getCorners(obj);
    ctx.fillStyle = COL.selected;
    for (const c of corners) {
        ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
    }
}

// Return corner positions for rect objects
function getCorners(obj) {
    if (obj.type === 'room' || obj.type === 'furniture') {
        return [
            { x: obj.x,         y: obj.y },
            { x: obj.x + obj.w, y: obj.y },
            { x: obj.x + obj.w, y: obj.y + obj.h },
            { x: obj.x,         y: obj.y + obj.h },
        ];
    }
    return [];
}


// ============================================================
// MAIN RENDER
// ============================================================

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Canvas background
    ctx.fillStyle = COL.canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();

    // Draw every object in order
    for (const obj of objects) {
        const s = (obj === selected);
        switch (obj.type) {
            case 'room':      drawRoom(obj, s);      break;
            case 'wall':      drawWall(obj, s);      break;
            case 'door':      drawDoor(obj, s);      break;
            case 'window':    drawWindow(obj, s);    break;
            case 'furniture': drawFurniture(obj, s); break;
        }
    }

    drawPreview();

    if (selected) drawSelectionHandles(selected);
}


// ============================================================
// HIT TESTING
// ============================================================

// Is (px, py) inside a rectangle object?
// Works with the normalised (positive w/h) objects stored in the array.
function pointInRect(px, py, obj) {
    return (
        px >= obj.x && px <= obj.x + obj.w &&
        py >= obj.y && py <= obj.y + obj.h
    );
}

// Is (px, py) near a line segment?  Uses vector projection to find the
// closest point on the segment, then checks distance.
function pointNearLine(px, py, obj) {
    const dx   = obj.x2 - obj.x;
    const dy   = obj.y2 - obj.y;
    const len2 = dx * dx + dy * dy;

    if (len2 === 0) {
        return Math.hypot(px - obj.x, py - obj.y) < HIT_DIST;
    }

    // Project the point onto the infinite line, then clamp t to [0, 1]
    // so we stay within the segment endpoints.
    let t = ((px - obj.x) * dx + (py - obj.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));

    const cx = obj.x + t * dx;
    const cy = obj.y + t * dy;
    return Math.hypot(px - cx, py - cy) < HIT_DIST;
}

// Return the topmost object under the cursor, or null.
function hitTest(mx, my) {
    // Search backwards so the last-drawn (topmost) object wins
    for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i];
        let hit = false;

        if (obj.type === 'room' || obj.type === 'furniture') {
            hit = pointInRect(mx, my, obj);
        } else if (obj.type === 'wall') {
            hit = pointNearLine(mx, my, obj);
        } else if (obj.type === 'door' || obj.type === 'window') {
            hit = Math.hypot(mx - obj.x, my - obj.y) < HIT_DIST;
        }

        if (hit) return obj;
    }
    return null;
}


// ============================================================
// EVENT HANDLERS
// ============================================================

function handleMouseDown(e) {
    const { x: mx, y: my } = getMousePos(e);

    switch (tool) {

        // ---- SELECT / MOVE ------------------------------------
        case 'select': {
            const hit = hitTest(mx, my);
            selected = hit;
            if (hit) {
                dragging = true;
                dragOffset = { x: mx - hit.x, y: my - hit.y };
            }
            render();
            break;
        }

        // ---- ROOM / WALL / FURNITURE (rubber-band) -----------
        case 'room':
        case 'wall':
        case 'furniture': {
            const sx = snap(mx);
            const sy = snap(my);
            placeStart = { x: sx, y: sy };
            preview = { type: tool, x: sx, y: sy, w: 0, h: 0 };
            if (tool === 'wall') {
                preview.x2 = sx;
                preview.y2 = sy;
            }
            break;
        }

        // ---- DOOR (click to place) ---------------------------
        case 'door': {
            objects.push({ type: 'door', x: snap(mx), y: snap(my) });
            render();
            break;
        }

        // ---- WINDOW (click to place) -------------------------
        case 'window': {
            objects.push({ type: 'window', x: snap(mx), y: snap(my) });
            render();
            break;
        }
    }
}

function handleMouseMove(e) {
    const { x: mx, y: my } = getMousePos(e);

    switch (tool) {

        // ---- SELECT / MOVE (drag selected object) ------------
        case 'select': {
            if (!dragging || !selected) break;

            const nx = snap(mx - dragOffset.x);
            const ny = snap(my - dragOffset.y);

            if (selected.type === 'room' || selected.type === 'furniture') {
                selected.x = nx;
                selected.y = ny;
            } else if (selected.type === 'wall') {
                // Move the whole wall by maintaining the offset between endpoints
                const dx = nx - selected.x;
                const dy = ny - selected.y;
                selected.x  = nx;
                selected.y  = ny;
                selected.x2 += dx;
                selected.y2 += dy;
            } else {
                // Door / Window — just move the point
                selected.x = nx;
                selected.y = ny;
            }
            render();
            break;
        }

        // ---- ROOM / FURNITURE (rubber-band) ------------------
        case 'room':
        case 'furniture': {
            if (!placeStart || !preview) break;
            preview.w = snap(mx) - placeStart.x;
            preview.h = snap(my) - placeStart.y;
            render();
            break;
        }

        // ---- WALL (rubber-band) ------------------------------
        case 'wall': {
            if (!placeStart || !preview) break;
            preview.x2 = snap(mx);
            preview.y2 = snap(my);
            render();
            break;
        }
    }
}

function handleMouseUp(e) {
    const { x: mx, y: my } = getMousePos(e);

    switch (tool) {

        // ---- SELECT (finish drag) ----------------------------
        case 'select': {
            dragging = false;
            dragOffset = { x: 0, y: 0 };
            break;
        }

        // ---- ROOM / FURNITURE (finish rubber-band) -----------
        case 'room':
        case 'furniture': {
            if (!placeStart || !preview) break;

            const w = Math.abs(preview.w);
            const h = Math.abs(preview.h);

            // Only create the object if it's bigger than one grid square
            if (w >= GRID && h >= GRID) {
                objects.push({
                    type: tool,
                    x: Math.min(preview.x, preview.x + preview.w),
                    y: Math.min(preview.y, preview.y + preview.h),
                    w: w,
                    h: h,
                });
            }

            preview    = null;
            placeStart = null;
            render();
            break;
        }

        // ---- WALL (finish rubber-band) -----------------------
        case 'wall': {
            if (!placeStart || !preview) break;

            const len = Math.hypot(preview.x2 - preview.x, preview.y2 - preview.y);

            if (len >= GRID) {
                objects.push({
                    type: 'wall',
                    x:  preview.x,
                    y:  preview.y,
                    x2: preview.x2,
                    y2: preview.y2,
                });
            }

            preview    = null;
            placeStart = null;
            render();
            break;
        }
    }
}


// ============================================================
// SAVE / LOAD / CLEAR / EXPORT
// ============================================================

function save() {
    localStorage.setItem('flort-objects', JSON.stringify(objects));
}

function load() {
    const raw = localStorage.getItem('flort-objects');
    if (raw) {
        objects  = JSON.parse(raw);
        selected = null;
        render();
    }
}

function clearAll() {
    if (objects.length === 0 || confirm('Clear all objects?')) {
        objects  = [];
        selected = null;
        render();
    }
}

function exportPNG() {
    const link    = document.createElement('a');
    link.download = 'floorplan.png';
    link.href     = canvas.toDataURL('image/png');
    link.click();
}


// ============================================================
// TOOLBAR WIRING
// ============================================================

// Tool buttons — set the active tool and reset transient state
document.querySelectorAll('.tool-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        tool     = btn.dataset.tool;
        selected = null;
        dragging = false;
        preview    = null;
        placeStart = null;

        document.querySelectorAll('.tool-btn').forEach(function (b) {
            b.classList.remove('active');
        });
        btn.classList.add('active');

        render();
    });
});

// Action buttons
document.getElementById('clearBtn').addEventListener('click', clearAll);
document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('loadBtn').addEventListener('click', load);
document.getElementById('exportBtn').addEventListener('click', exportPNG);


// ============================================================
// INITIALISE
// ============================================================

canvas.addEventListener('mousedown', handleMouseDown);
canvas.addEventListener('mousemove', handleMouseMove);
// mouseup on window so dragging ends even if the cursor leaves the canvas
window.addEventListener('mouseup', handleMouseUp);

canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
window.addEventListener('resize', resizeCanvas);

resizeCanvas();
