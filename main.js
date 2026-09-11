// ============================================================
// Flort — Floor Plan Maker (main.js)
// Pure vanilla JS — no frameworks or libraries
// ============================================================


// ----- Constants ---------------------------------------------------

const GRID = 20;            // One grid square = 20 pixels
const METERS_PER_GRID = 1; // 20 px represents 1 metre
const WALL_THICK = 4;       // Wall line width (px)
const DOOR_SIZE = 10;       // Door marker radius (px)

const HIT_DIST = 8;         // Max pixel distance for a wall hit-test
const MAGNET_DIST = 10;     // Pixels within which furniture snaps to a wall
const FURNITURE_KINDS = {   // Preset furniture proportions (px at 1 m/grid)
    bed:   { ratio: 2, label: 'Bed' },
    table: { ratio: 1, label: 'Table' },
    sofa:  { ratio: 3, label: 'Sofa' },
};


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
    collision:    '#ff4b4b',
    selected:     '#00d4aa',
    preview:      'rgba(0, 212, 170, 0.25)',
    previewLine:  '#00d4aa',
};


// ----- Application state -------------------------------------------

let objects    = [];     // All placed floor-plan objects
let tool       = 'select'; // Current tool name
let selection  = [];     // Currently selected objects (marquee can select many)
let dragging   = false;  // True while the user drags with Select tool
let dragBase   = null;   // Initial positions of the selected group at drag start
let dragStartMouse = { x: 0, y: 0 }; // Grid-snapped mouse at drag start
let placeStart = null;   // Grid-snapped start point while drawing
let preview    = null;   // Temporary preview object shown while dragging

// Undo / Redo stacks — each entry is a JSON snapshot of objects[]
let undoStack = [];
let redoStack = [];

// CAD-lite interaction state
let wallGrip      = null;       // 'start' | 'end' — which wall endpoint follows the mouse
let rotating      = false;      // True while dragging a furniture rotation handle
let furnitureKind = 'bed';      // Currently selected furniture preset
let rafPending    = false;      // Dirty flag for requestAnimationFrame render coalescing
let editingRoom   = null;      // Room whose name is being edited (or null)
let marqueeStart  = null;      // Where the user pressed to begin a marquee (or null)
let marqueeRect   = null;      // Live marquee box while dragging (or null)


// ----- Canvas setup ------------------------------------------------

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// Overlay input used to rename rooms (hidden until a room is edited)
const roomLabelInput = document.getElementById('roomLabelInput');

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
// CAD-LITE HELPERS
// ============================================================

// Effective axis-aligned box for an object. Furniture rotates in 90-degree
// steps, so rotating swaps w/h around the same center and the result is
// still axis-aligned — no canvas transforms are needed.
function getRectFor(obj) {
    if (obj.type === 'furniture' && (obj.angle === 90 || obj.angle === 270)) {
        const cx = obj.x + obj.w / 2;
        const cy = obj.y + obj.h / 2;
        return { x: cx - obj.h / 2, y: cy - obj.w / 2, w: obj.h, h: obj.w };
    }
    return obj;
}

// The only selected object, or null when multiple (or none) are selected.
function selSingle() {
    return selection.length === 1 ? selection[0] : null;
}

// Lock a rubber-band size to a width:height ratio, keeping each dimension
// on the grid. The dominant axis drives the shape.
function ratioRect(w, h, ratio) {
    const signW = w < 0 ? -1 : 1;
    const signH = h < 0 ? -1 : 1;
    let aw = Math.abs(w);
    let ah = Math.abs(h);
    if (aw === 0 && ah === 0) return { w: 0, h: 0 };
    if (aw * ratio >= ah) {
        ah = Math.round(aw / ratio / GRID) * GRID;
    } else {
        aw = Math.round(ah * ratio / GRID) * GRID;
    }
    return { w: signW * aw, h: signH * ah };
}

// Position of a furniture piece's rotation handle (above its top edge)
function rotateHandlePos(obj) {
    const box = getRectFor(obj);
    return { x: box.x + box.w / 2, y: box.y - 18 };
}

// Is (px, py) near the rotation handle of this furniture?
function nearRotateHandle(obj, px, py) {
    const h = rotateHandlePos(obj);
    return Math.hypot(px - h.x, py - h.y) < 14;
}

// Set the selected furniture's angle to the nearest 90° step facing the
// pointer, measured from the furniture's center.
function rotateSelectedToPointer(mx, my) {
    const solo = selSingle();
    if (!solo || solo.type !== 'furniture') return;
    const box = getRectFor(solo);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let deg = Math.round(Math.atan2(my - cy, mx - cx) * 180 / Math.PI / 90) * 90;
    solo.angle = ((deg % 360) + 360) % 360;
}

// Magnetic wall snapping: if an edge of the furniture's effective box is
// within MAGNET_DIST of an axis-aligned wall, return the {dx, dy} offset
// that slides it flush against the wall. Returns null if nothing is near.
function magnetSnap(furn) {
    if (!furn || furn.type !== 'furniture') return null;

    const box = getRectFor(furn);
    let best = null;
    let bestDist = MAGNET_DIST + 1;

    for (const other of objects) {
        if (other === furn || other.type !== 'wall') continue;
        // Only horizontal / vertical walls participate (v1)
        if (other.x !== other.x2 && other.y !== other.y2) continue;

        if (other.x === other.x2) {
            // Vertical wall — align nearest left/right furniture edge
            const dLeft  = Math.abs(box.x - other.x);
            const dRight = Math.abs(box.x + box.w - other.x);
            const d = Math.min(dLeft, dRight);
            if (d <= MAGNET_DIST && d < bestDist) {
                bestDist = d;
                best = dLeft <= dRight
                    ? { dx: other.x - box.x, dy: 0 }
                    : { dx: other.x - (box.x + box.w), dy: 0 };
            }
        } else {
            // Horizontal wall — align nearest top/bottom furniture edge
            const dTop    = Math.abs(box.y - other.y);
            const dBottom = Math.abs(box.y + box.h - other.y);
            const d = Math.min(dTop, dBottom);
            if (d <= MAGNET_DIST && d < bestDist) {
                bestDist = d;
                best = dTop <= dBottom
                    ? { dx: 0, dy: other.y - box.y }
                    : { dx: 0, dy: other.y - (box.y + box.h) };
            }
        }
    }
    return best;
}

// Endpoint-to-endpoint snapping: if (ex, ey) is within MAGNET_DIST of an
// existing wall's endpoint, return that endpoint's {x, y}.  skipWall is
// excluded (the wall currently being stretched).  Returns null if nothing
// is near.
function wallEndpointSnap(ex, ey, skipWall) {
    let best = null;
    let bestDist = MAGNET_DIST + 1;
    for (const w of objects) {
        if (w.type !== 'wall' || w === skipWall) continue;
        // Both endpoints of every wall
        var pts = [
            { x: w.x,  y: w.y  },
            { x: w.x2, y: w.y2 },
        ];
        for (var i = 0; i < 2; i++) {
            var d = Math.hypot(ex - pts[i].x, ey - pts[i].y);
            if (d <= MAGNET_DIST && d < bestDist) {
                bestDist = d;
                best = pts[i];
            }
        }
    }
    return best;
}

// Does segment (a1,b1)-(a2,b2) cross segment (c1,d1)-(c2,d2)?
function segmentCrosses(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay;
    const d2x = dx - cx, d2y = dy - cy;
    const det = d1x * d2y - d1y * d2x;
    if (Math.abs(det) < 1e-9) return false; // parallel
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / det;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / det;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Does a line segment pass through an axis-aligned box?
// (Uses strict bounds so an endpoint merely touching an edge is not a hit.)
function segmentHitsBox(x1, y1, x2, y2, box) {
    const r = box.x + box.w;
    const b = box.y + box.h;
    // Endpoint strictly inside the box?
    if (x1 > box.x && x1 < r && y1 > box.y && y1 < b) return true;
    if (x2 > box.x && x2 < r && y2 > box.y && y2 < b) return true;
    // Segment crossing any of the four box edges?
    return segmentCrosses(x1, y1, x2, y2, box.x, box.y, r, box.y) ||
           segmentCrosses(x1, y1, x2, y2, r, box.y, r, b) ||
           segmentCrosses(x1, y1, x2, y2, r, b, box.x, b) ||
           segmentCrosses(x1, y1, x2, y2, box.x, b, box.x, box.y);
}

// AABB overlap test (uses effective boxes so rotated furniture works)
function boxesOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
}

// Does the given furniture overlap a wall or another piece of furniture?
function furnitureCollides(furn) {
    const box = getRectFor(furn);
    for (const other of objects) {
        if (other === furn) continue;
        if (other.type === 'furniture') {
            if (boxesOverlap(box, getRectFor(other))) return true;
        } else if (other.type === 'wall') {
            if (segmentHitsBox(other.x, other.y, other.x2, other.y2, box)) return true;
        }
    }
    return false;
}

// Colliding objects, recomputed every frame. Kept separate from objects[]
// so the collision flag never leaks into save / undo snapshots.
let colliding = new Set();

// Mark every furniture piece that currently collides
function computeCollisions() {
    colliding = new Set();
    for (const obj of objects) {
        if (obj.type === 'furniture' && furnitureCollides(obj)) colliding.add(obj);
    }
}

// Coalesce renders onto the next animation frame (keeps drags at 60fps)
function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
        rafPending = false;
        render();
    });
}


// ============================================================
// UNDO / REDO
// ============================================================

// Save a snapshot of the current state before a mutation
function pushUndo() {
    undoStack.push(JSON.stringify(objects));
    redoStack = [];
    updateUndoRedoButtons();
}

// Restore the state before the last mutation
function undo() {
    commitRoomEdit(); // finish any label edit first so it becomes undoable
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(objects));
    objects  = JSON.parse(undoStack.pop());
    selection = [];
    updateDeleteButton();
    render();
    updateUndoRedoButtons();
}

// Re-apply the last undone mutation
function redo() {
    commitRoomEdit();
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(objects));
    objects  = JSON.parse(redoStack.pop());
    selection = [];
    updateDeleteButton();
    render();
    updateUndoRedoButtons();
}

// Grey out buttons when their stack is empty
function updateUndoRedoButtons() {
    document.getElementById('undoBtn').disabled = undoStack.length === 0;
    document.getElementById('redoBtn').disabled = redoStack.length === 0;
}

// Grey out Delete button when nothing is selected
function updateDeleteButton() {
    document.getElementById('deleteBtn').disabled = selection.length === 0;
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
        // Brighter line every 5 squares (every 5 m)
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

    // Labels — dimensions, plus the room name above them if one is set
    if (obj.w > 40 && obj.h > 30) {
        const cx      = obj.x + obj.w / 2;
        const cy      = obj.y + obj.h / 2;
        const hasName = obj.name && obj.name.length > 0;
        const dims    = pxToM(obj.w) + 'm \u00d7 ' + pxToM(obj.h) + 'm';

        ctx.textAlign = 'center';
        if (hasName) {
            ctx.fillStyle    = isSel ? COL.selected : COL.roomLabel;
            ctx.font         = 'bold 12px sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.fillText(obj.name, cx, cy - 2);
            ctx.font         = '10px sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(dims, cx, cy + 2);
        } else {
            ctx.fillStyle    = isSel ? COL.selected : COL.roomLabel;
            ctx.font         = '12px sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(dims, cx, cy);
        }
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

// -- Window (rectangle placed along a wall) ----------------------

function drawWindow(obj, isSel) {
    ctx.fillStyle = isSel ? 'rgba(0,212,170,0.12)' : 'rgba(74, 255, 184, 0.15)';
    ctx.fillRect(obj.x, obj.y, obj.w, obj.h);

    ctx.strokeStyle = isSel ? COL.selected : COL.window;
    ctx.lineWidth   = isSel ? 2 : 1.5;
    ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);

    if (obj.w > 24 && obj.h > 16) {
        ctx.fillStyle    = isSel ? COL.selected : COL.window;
        ctx.font         = '10px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Window', obj.x + obj.w / 2, obj.y + obj.h / 2);
    }
}

// -- Furniture (filled rectangle with label) --------------------

function drawFurniture(obj, isSel) {
    const box   = getRectFor(obj);
    const label = obj.label || 'Furniture';
    const bad   = colliding.has(obj);

    // Fill (slightly different tint per preset kind)
    ctx.fillStyle = isSel ? 'rgba(0,212,170,0.12)' :
                   (obj.kind === 'table' ? 'rgba(50, 100, 70, 0.5)' :
                    obj.kind === 'sofa'  ? 'rgba(120, 60, 40, 0.5)' : COL.furniture);
    ctx.fillRect(box.x, box.y, box.w, box.h);

    // Border — red when colliding with a wall or another piece of furniture
    ctx.strokeStyle = bad ? COL.collision : (isSel ? COL.selected : COL.furnBorder);
    ctx.lineWidth   = bad ? 2.5 : (isSel ? 2 : 1.5);
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    if (box.w > 24 && box.h > 18) {
        ctx.save();
        ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
        // Rotate the label with the furniture for 90/270
        if (obj.angle === 90)          ctx.rotate(Math.PI / 2);
        else if (obj.angle === 270)    ctx.rotate(-Math.PI / 2);
        ctx.fillStyle    = bad ? COL.collision : (isSel ? COL.selected : COL.furnLabel);
        ctx.font         = '10px sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 0);
        ctx.restore();
    }
}

// -- Preview (dashed outline while dragging) --------------------

function drawPreview() {
    if (!preview) return;

    ctx.save();
    ctx.globalAlpha = 0.7;

    if (preview.type === 'room' || preview.type === 'furniture' || preview.type === 'window') {
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
            // Label the preset kind above the dimensions for furniture
            if (preview.type === 'furniture') {
                ctx.fillStyle = COL.selected;
                ctx.font      = '10px sans-serif';
                ctx.fillText(FURNITURE_KINDS[furnitureKind].label,
                    preview.x + preview.w / 2, preview.y + preview.h / 2 - 10);
            }
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

// -- Selection glow (offset outline under the handles) ---------

function drawSelectionGlow(obj) {
    if (obj.type === 'wall') {
        ctx.beginPath();
        ctx.moveTo(obj.x, obj.y);
        ctx.lineTo(obj.x2, obj.y2);
        ctx.strokeStyle = 'rgba(0,212,170,0.25)';
        ctx.lineWidth   = WALL_THICK + 6;
        ctx.lineCap     = 'round';
        ctx.stroke();
        return;
    }
    if (obj.type === 'door') {
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, DOOR_SIZE + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,212,170,0.25)';
        ctx.lineWidth   = 2;
        ctx.stroke();
        return;
    }
    const box = getRectFor(obj);
    ctx.strokeStyle = 'rgba(0,212,170,0.30)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
}

// -- Selection handles (small squares at corners) ---------------

function drawSelectionHandles(obj) {
    // Glow first so it sits beneath the corner handles
    drawSelectionGlow(obj);

    const corners = getCorners(obj);
    ctx.fillStyle = COL.selected;
    for (const c of corners) {
        ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
    }

    // Furniture gets a circular rotation handle above its top edge
    // (only when this is the single selected piece)
    if (obj.type === 'furniture' && selSingle() === obj) {
        const h = rotateHandlePos(obj);
        ctx.beginPath();
        ctx.arc(h.x, h.y, 7, 0, Math.PI * 2);
        ctx.fillStyle   = COL.selected;
        ctx.fill();
        ctx.strokeStyle = COL.canvasBg;
        ctx.lineWidth   = 2;
        ctx.stroke();
        ctx.fillStyle   = COL.canvasBg;
        ctx.font        = 'bold 11px sans-serif';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u27F3', h.x, h.y + 0.5);

        // Live angle readout while rotating the handle
        if (rotating && selSingle() === obj) {
            const label = ((obj.angle || 0) % 360) + '\u00B0';
            ctx.font     = 'bold 10px sans-serif';
            const tw     = ctx.measureText(label).width;
            const px     = h.x - tw / 2 - 5;
            const py     = h.y - 26;
            ctx.fillStyle   = 'rgba(15,15,19,0.85)';
            ctx.strokeStyle = COL.selected;
            ctx.lineWidth   = 1;
            ctx.fillRect(px, py, tw + 10, 15);
            ctx.strokeRect(px, py, tw + 10, 15);
            ctx.fillStyle    = COL.selected;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, h.x, py + 7.5);
        }
    }
}

// Return corner positions for rect objects (uses effective box for rotation)
function getCorners(obj) {
    if (obj.type !== 'room' && obj.type !== 'furniture' && obj.type !== 'window') return [];
    const box = getRectFor(obj);
    return [
        { x: box.x,         y: box.y },
        { x: box.x + box.w, y: box.y },
        { x: box.x + box.w, y: box.y + box.h },
        { x: box.x,         y: box.y + box.h },
    ];
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

    // Refresh collision flags before drawing (red borders for overlaps)
    computeCollisions();

    // Draw every object in order
    for (const obj of objects) {
        const s = selection.includes(obj);
        switch (obj.type) {
            case 'room':      drawRoom(obj, s);      break;
            case 'wall':      drawWall(obj, s);      break;
            case 'door':      drawDoor(obj, s);      break;
            case 'window':    drawWindow(obj, s);    break;
            case 'furniture': drawFurniture(obj, s); break;
        }
    }

    drawPreview();

    // Selection handles for every selected object
    for (const obj of selection) drawSelectionHandles(obj);

    // Marquee selection box (drawn last so it overlays everything)
    if (marqueeRect) {
        ctx.save();
        ctx.fillStyle   = 'rgba(0,212,170,0.08)';
        ctx.fillRect(marqueeRect.x, marqueeRect.y, marqueeRect.w, marqueeRect.h);
        ctx.strokeStyle = COL.previewLine;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(marqueeRect.x, marqueeRect.y, marqueeRect.w, marqueeRect.h);
        ctx.setLineDash([]);
        ctx.restore();
    }
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

        if (obj.type === 'room' || obj.type === 'furniture' || obj.type === 'window') {
            hit = pointInRect(mx, my, getRectFor(obj));
        } else if (obj.type === 'wall') {
            hit = pointNearLine(mx, my, obj);
        } else if (obj.type === 'door') {
            hit = Math.hypot(mx - obj.x, my - obj.y) < HIT_DIST;
        }

        if (hit) return obj;
    }
    return null;
}

// Return every object intersecting the marquee box (for multi-select).
function hitTestMarquee(r) {
    const hits = [];
    const inRect = function (px, py) {
        return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    };

    for (const obj of objects) {
        if (obj.type === 'room' || obj.type === 'furniture' || obj.type === 'window') {
            if (boxesOverlap(getRectFor(obj), r)) hits.push(obj);
        } else if (obj.type === 'wall') {
            // Selected when an endpoint is inside the box or the segment
            // crosses any of the box's four edges (intersection, not
            // containment — partial walls get caught).
            if (inRect(obj.x, obj.y) || inRect(obj.x2, obj.y2)) {
                hits.push(obj);
            } else if (
                segmentCrosses(obj.x, obj.y, obj.x2, obj.y2, r.x, r.y, r.x + r.w, r.y) ||
                segmentCrosses(obj.x, obj.y, obj.x2, obj.y2, r.x + r.w, r.y, r.x + r.w, r.y + r.h) ||
                segmentCrosses(obj.x, obj.y, obj.x2, obj.y2, r.x + r.w, r.y + r.h, r.x, r.y + r.h) ||
                segmentCrosses(obj.x, obj.y, obj.x2, obj.y2, r.x, r.y + r.h, r.x, r.y)
            ) {
                hits.push(obj);
            }
        } else if (obj.type === 'door') {
            if (inRect(obj.x, obj.y)) hits.push(obj);
        }
    }
    return hits;
}


// ============================================================
// EVENT HANDLERS
// ============================================================

function handleMouseDown(e) {
    const { x: mx, y: my } = getMousePos(e);

    switch (tool) {

        // ---- SELECT / MOVE ------------------------------------
        case 'select': {
            // Rotation handle takes priority when a single furniture is selected
            const solo = selSingle();
            if (solo && solo.type === 'furniture' && nearRotateHandle(solo, mx, my)) {
                pushUndo();           // snapshot before the rotation
                rotating = true;
                rotateSelectedToPointer(mx, my);
                render();
                break;
            }

            const hit = hitTest(mx, my);
            if (hit) {
                if (selection.length > 1 && selection.includes(hit)) {
                    // Clicking a member of a multi-selection drags the whole group
                    wallGrip = null;
                } else {
                    // Fresh selection — walls grab an endpoint for stretching
                    selection = [hit];
                    if (hit.type === 'wall') {
                        // Stretch: the endpoint closer to the click becomes the grip
                        const dStart = Math.hypot(mx - hit.x, my - hit.y);
                        const dEnd   = Math.hypot(mx - hit.x2, my - hit.y2);
                        wallGrip = dStart <= dEnd ? 'start' : 'end';
                    }
                }
                updateDeleteButton();
                pushUndo(); // snapshot before potential move / stretch
                dragging = true;
                dragBase = selection.map(function (o) {
                    return { obj: o, x: o.x, y: o.y, x2: o.x2, y2: o.y2 };
                });
                dragStartMouse = { x: snap(mx), y: snap(my) };
            } else {
                // Empty space: begin (or restart) a marquee selection
                marqueeStart = { x: mx, y: my };
                marqueeRect  = null;
            }
            render();
            break;
        }

        // ---- ROOM / WALL / FURNITURE / WINDOW (rubber-band) ---
        case 'room':
        case 'wall':
        case 'furniture':
        case 'window': {
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
            pushUndo();
            objects.push({ type: 'door', x: snap(mx), y: snap(my) });
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
            // Expanding a marquee: track the live selection box
            if (marqueeStart) {
                marqueeRect = {
                    x: Math.min(marqueeStart.x, mx),
                    y: Math.min(marqueeStart.y, my),
                    w: Math.abs(mx - marqueeStart.x),
                    h: Math.abs(my - marqueeStart.y),
                };
                requestRender();
                break;
            }

            if (!dragging || !dragBase) break;

            // Furniture rotation: drag the handle around the center
            if (rotating) {
                rotateSelectedToPointer(mx, my);
                requestRender();
                break;
            }

            // Wall stretching: slide the grip endpoint, keep the anchor fixed.
            // If the moving endpoint is near another wall's endpoint, snap to it.
            if (wallGrip && dragBase.length === 1 && dragBase[0].obj.type === 'wall') {
                const wall = dragBase[0].obj;
                var tx = snap(mx);
                var ty = snap(my);
                var ep = wallEndpointSnap(tx, ty, wall);
                var gx = ep ? ep.x : tx;
                var gy = ep ? ep.y : ty;
                if (wallGrip === 'start') {
                    wall.x = gx;
                    wall.y = gy;
                } else {
                    wall.x2 = gx;
                    wall.y2 = gy;
                }
                requestRender();
                break;
            }

            // Translate every selected object by the same grid delta
            const dx = snap(mx) - dragStartMouse.x;
            const dy = snap(my) - dragStartMouse.y;
            for (const b of dragBase) {
                b.obj.x = b.x + dx;
                b.obj.y = b.y + dy;
                if (b.obj.type === 'wall') {
                    b.obj.x2 = b.x2 + dx;
                    b.obj.y2 = b.y2 + dy;
                }
                // Magnetic wall snap wins over plain grid snapping when close
                if (b.obj.type === 'furniture') {
                    const mag = magnetSnap(b.obj);
                    if (mag) {
                        b.obj.x += mag.dx;
                        b.obj.y += mag.dy;
                    }
                }
            }
            requestRender();
            break;
        }

        // ---- ROOM / FURNITURE / WINDOW (rubber-band) ----------
        case 'room':
        case 'furniture':
        case 'window': {
            if (!placeStart || !preview) break;
            if (tool === 'furniture') {
                // Lock the preview to the selected preset's aspect ratio
                const r = ratioRect(snap(mx) - placeStart.x, snap(my) - placeStart.y,
                                    FURNITURE_KINDS[furnitureKind].ratio);
                preview.w = r.w;
                preview.h = r.h;
            } else {
                preview.w = snap(mx) - placeStart.x;
                preview.h = snap(my) - placeStart.y;
            }
            requestRender();
            break;
        }

        // ---- WALL (rubber-band) ------------------------------
        case 'wall': {
            if (!placeStart || !preview) break;
            var tx = snap(mx);
            var ty = snap(my);
            var ep = wallEndpointSnap(tx, ty, null);
            preview.x2 = ep ? ep.x : tx;
            preview.y2 = ep ? ep.y : ty;
            requestRender();
            break;
        }
    }
}

function handleMouseUp(e) {
    const { x: mx, y: my } = getMousePos(e);

    switch (tool) {

        // ---- SELECT (finish drag / marquee) -----------------
        case 'select': {
            // Finish a marquee: select everything the box touches
            if (marqueeStart) {
                if (marqueeRect && (marqueeRect.w > 2 || marqueeRect.h > 2)) {
                    selection = hitTestMarquee(marqueeRect);
                    updateDeleteButton();
                } else {
                    // Plain click on empty space — deselect everything
                    selection = [];
                    updateDeleteButton();
                }
                marqueeStart = null;
                marqueeRect  = null;
            }
            dragging = false;
            rotating = false;
            wallGrip = null;
            dragBase = null;
            render();
            break;
        }

        // ---- ROOM / FURNITURE / WINDOW (finish rubber-band) ---
        case 'room':
        case 'furniture':
        case 'window': {
            if (!placeStart || !preview) break;

            const w = Math.abs(preview.w);
            const h = Math.abs(preview.h);

            // Only create the object if it's bigger than one grid square
            if (w >= GRID && h >= GRID) {
                pushUndo();
                const x = Math.min(preview.x, preview.x + preview.w);
                const y = Math.min(preview.y, preview.y + preview.h);
                if (tool === 'furniture') {
                    objects.push({
                        type: 'furniture',
                        x: x, y: y, w: w, h: h,
                        kind: furnitureKind,
                        label: FURNITURE_KINDS[furnitureKind].label,
                        angle: 0,
                    });
                } else {
                    objects.push({ type: tool, x: x, y: y, w: w, h: h });
                }
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
                pushUndo();
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
// ROOM LABEL EDITING
// ============================================================

// Position the overlay input over the middle of the room
function centerRoomEditor(room) {
    const cr = canvas.getBoundingClientRect();
    const cx = cr.left + room.x + room.w / 2;
    const cy = cr.top  + room.y + room.h / 2;
    roomLabelInput.style.left  = cx + 'px';
    roomLabelInput.style.top   = cy + 'px';
    roomLabelInput.style.width = Math.min(Math.max(room.w - 8, 60), 240) + 'px';
}

// Open the name editor for a room (committing any other open edit first)
function openRoomEditor(room) {
    commitRoomEdit();
    editingRoom = room;
    roomLabelInput.value = room.name || '';
    centerRoomEditor(room);
    roomLabelInput.classList.add('visible');
    roomLabelInput.focus();
    roomLabelInput.select();
}

// Save the typed name (snapshot first so Undo restores the old name)
function commitRoomEdit() {
    if (!editingRoom) return;
    const text = roomLabelInput.value.trim();
    const prev = editingRoom.name || '';
    roomLabelInput.classList.remove('visible');
    if (text !== prev) {
        pushUndo();
        editingRoom.name = text;
    }
    editingRoom = null;
    render();
}

// Dismiss the editor without saving
function cancelRoomEdit() {
    roomLabelInput.classList.remove('visible');
    editingRoom = null;
    render();
}


// ============================================================
// SAVE / LOAD / CLEAR / EXPORT
// ============================================================

function save() {
    localStorage.setItem('flort-objects', JSON.stringify(objects));
}

function load() {
    cancelRoomEdit(); // editor holds a reference to an object being replaced
    const raw = localStorage.getItem('flort-objects');
    if (raw) {
        objects   = JSON.parse(raw);
        selection = [];
        undoStack = [];
        redoStack = [];
        updateUndoRedoButtons();
        updateDeleteButton();
        render();
    }
}

function clearAll() {
    if (objects.length === 0 || confirm('Clear all objects?')) {
        cancelRoomEdit(); // wiped objects, so the editor reference is stale
        pushUndo();
        objects  = [];
        selection = [];
        updateDeleteButton();
        render();
    }
}

function deleteSelected() {
    if (selection.length === 0) return;
    cancelRoomEdit(); // deleting the room being edited
    pushUndo();
    const doomed = new Set(selection);
    objects = objects.filter(function (o) { return !doomed.has(o); });
    selection = [];
    updateDeleteButton();
    render();
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
        selection = [];
        updateDeleteButton();
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
document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);
document.getElementById('deleteBtn').addEventListener('click', deleteSelected);

// Furniture preset dropdown
document.getElementById('furnitureMenu').addEventListener('change', function (e) {
    furnitureKind = e.target.value;
});

// Keyboard shortcuts (ignored while typing in the label editor)
document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    // Ctrl+Z / Cmd+Z = Undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    }
    // Ctrl+Y / Cmd+Y  or  Ctrl+Shift+Z / Cmd+Shift+Z = Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
    }
    // Delete / Backspace = Remove selected object
    if (e.key === 'Delete' || e.key === 'Backspace') {
        // Prevent Backspace from navigating back in the browser
        e.preventDefault();
        deleteSelected();
    }
});


// ============================================================
// INITIALISE
// ============================================================

canvas.addEventListener('mousedown', handleMouseDown);
canvas.addEventListener('mousemove', handleMouseMove);
// mouseup on window so dragging ends even if the cursor leaves the canvas
window.addEventListener('mouseup', handleMouseUp);

// Double-click a room (in Select mode) to rename it
canvas.addEventListener('dblclick', function (e) {
    if (tool !== 'select') return;
    const { x, y } = getMousePos(e);
    const hit = hitTest(x, y);
    if (hit && hit.type === 'room') openRoomEditor(hit);
});

// Commit the label on Enter, cancel on Escape
roomLabelInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        commitRoomEdit();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRoomEdit();
    }
});

// Clicking anywhere else commits the current edit
roomLabelInput.addEventListener('blur', commitRoomEdit);

canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
window.addEventListener('resize', resizeCanvas);

resizeCanvas();
