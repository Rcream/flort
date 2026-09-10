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
let selected   = null;   // The object currently selected (or null)
let dragging   = false;  // True while the user drags with Select tool
let dragOffset = { x: 0, y: 0 }; // Mouse-to-object offset during drag
let placeStart = null;   // Grid-snapped start point while drawing
let preview    = null;   // Temporary preview object shown while dragging

// Undo / Redo stacks — each entry is a JSON snapshot of objects[]
let undoStack = [];
let redoStack = [];

// CAD-lite interaction state
let wallGrip      = null;       // 'start' | 'end' — which wall endpoint follows the mouse
let gripMouse     = { x: 0, y: 0 }; // Last snap()-ped grip position while stretching
let rotating      = false;      // True while dragging a furniture rotation handle
let furnitureKind = 'bed';      // Currently selected furniture preset
let rafPending    = false;      // Dirty flag for requestAnimationFrame render coalescing


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
    if (!selected || selected.type !== 'furniture') return;
    const box = getRectFor(selected);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let deg = Math.round(Math.atan2(my - cy, mx - cx) * 180 / Math.PI / 90) * 90;
    selected.angle = ((deg % 360) + 360) % 360;
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
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(objects));
    objects  = JSON.parse(undoStack.pop());
    selected = null;
    updateDeleteButton();
    render();
    updateUndoRedoButtons();
}

// Re-apply the last undone mutation
function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(objects));
    objects  = JSON.parse(redoStack.pop());
    selected = null;
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
    document.getElementById('deleteBtn').disabled = !selected;
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

// -- Selection handles (small squares at corners) ---------------

function drawSelectionHandles(obj) {
    const corners = getCorners(obj);
    ctx.fillStyle = COL.selected;
    for (const c of corners) {
        ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
    }

    // Furniture gets a circular rotation handle above its top edge
    if (obj.type === 'furniture') {
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


// ============================================================
// EVENT HANDLERS
// ============================================================

function handleMouseDown(e) {
    const { x: mx, y: my } = getMousePos(e);

    switch (tool) {

        // ---- SELECT / MOVE ------------------------------------
        case 'select': {
            // Rotation handle takes priority when a furniture piece is selected
            if (selected && selected.type === 'furniture' && nearRotateHandle(selected, mx, my)) {
                pushUndo();           // snapshot before the rotation
                rotating = true;
                rotateSelectedToPointer(mx, my);
                render();
                break;
            }

            const hit = hitTest(mx, my);
            selected = hit;
            updateDeleteButton();
            if (hit) {
                pushUndo(); // snapshot before potential move / stretch
                dragging = true;
                if (hit.type === 'wall') {
                    // Stretch: the endpoint closer to the click becomes the grip
                    const dStart = Math.hypot(mx - hit.x, my - hit.y);
                    const dEnd   = Math.hypot(mx - hit.x2, my - hit.y2);
                    wallGrip  = dStart <= dEnd ? 'start' : 'end';
                    gripMouse = { x: snap(mx), y: snap(my) };
                } else if (hit.type === 'room' || hit.type === 'furniture' || hit.type === 'window') {
                    const r = getRectFor(hit);
                    dragOffset = { x: mx - r.x, y: my - r.y };
                } else {
                    dragOffset = { x: mx - hit.x, y: my - hit.y };
                }
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
            if (!dragging || !selected) break;

            // Furniture rotation: drag the handle around the center
            if (rotating) {
                rotateSelectedToPointer(mx, my);
                requestRender();
                break;
            }

            // Wall stretching: slide the grip endpoint, keep the anchor fixed
            if (selected.type === 'wall' && wallGrip) {
                const sx = snap(mx);
                const sy = snap(my);
                const dx = sx - gripMouse.x;
                const dy = sy - gripMouse.y;
                if (wallGrip === 'start') {
                    selected.x += dx;
                    selected.y += dy;
                } else {
                    selected.x2 += dx;
                    selected.y2 += dy;
                }
                gripMouse = { x: sx, y: sy };
                requestRender();
                break;
            }

            const nx = snap(mx - dragOffset.x);
            const ny = snap(my - dragOffset.y);

            if (selected.type === 'furniture') {
                // Move via the effective box so rotated pieces track the pointer
                const cur = getRectFor(selected);
                selected.x += nx - cur.x;
                selected.y += ny - cur.y;
                // Magnetic wall snap wins over plain grid snapping when close
                const mag = magnetSnap(selected);
                if (mag) {
                    selected.x += mag.dx;
                    selected.y += mag.dy;
                }
            } else if (selected.type === 'room' || selected.type === 'window') {
                selected.x = nx;
                selected.y = ny;
            } else {
                // Door — just move the point
                selected.x = nx;
                selected.y = ny;
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
            preview.x2 = snap(mx);
            preview.y2 = snap(my);
            requestRender();
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
            rotating = false;
            wallGrip = null;
            dragOffset = { x: 0, y: 0 };
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
// SAVE / LOAD / CLEAR / EXPORT
// ============================================================

function save() {
    localStorage.setItem('flort-objects', JSON.stringify(objects));
}

function load() {
    const raw = localStorage.getItem('flort-objects');
    if (raw) {
        objects   = JSON.parse(raw);
        selected  = null;
        undoStack = [];
        redoStack = [];
        updateUndoRedoButtons();
        updateDeleteButton();
        render();
    }
}

function clearAll() {
    if (objects.length === 0 || confirm('Clear all objects?')) {
        pushUndo();
        objects  = [];
        selected = null;
        updateDeleteButton();
        render();
    }
}

function deleteSelected() {
    if (!selected) return;
    pushUndo();
    objects = objects.filter(function (o) { return o !== selected; });
    selected = null;
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
        selected = null;
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

// Keyboard shortcuts
document.addEventListener('keydown', function (e) {
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

canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
window.addEventListener('resize', resizeCanvas);

resizeCanvas();
