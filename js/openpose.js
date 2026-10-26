import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import "./fabric.min.js";

function dataURLToBlob(dataurl) {
    var arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

const connect_keypoints = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [1, 5], [5, 6], [6, 7], [1, 8],
    [8, 9], [9, 10], [1, 11], [11, 12],
    [12, 13], [14, 0], [14, 16], [15, 0],
    [15, 17]
];

const connect_color = [
    [0, 0, 255], [255, 0, 0], [255, 170, 0], [255, 255, 0],
    [255, 85, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
    [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255],
    [0, 85, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
    [255, 0, 170], [255, 0, 85]
];

const DEFAULT_KEYPOINTS = [
    [241, 77], [241, 120], [191, 118], [177, 183],
    [163, 252], [298, 118], [317, 182], [332, 245],
    [225, 241], [213, 359], [215, 454], [270, 240],
    [282, 360], [286, 456], [232, 59], [253, 60],
    [225, 70], [260, 72]
]

async function readFileToText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => resolve(reader.result);
        reader.onerror = async () => reject(reader.error);
        reader.readAsText(file);
    });
}

async function loadImageAsync(imageURL) {
    return new Promise((resolve) => {
        const e = new Image();
        e.setAttribute('crossorigin', 'anonymous');
        e.addEventListener("load", () => { resolve(e); });
        e.src = imageURL;
        return e;
    });
}

async function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
        canvas.toBlob(resolve);
    });
}

class OpenPosePanel {
    node = null;
    canvas = null;
    canvasElem = null;
    panel = null;

    undo_history = [];
    redo_history = [];

    visibleEyes = true;
    flipped = false;
    lockMode = false;
    
    // Caches the last pose data to avoid duplicate updates
    lastPoseData = null;

    deleteSelectedPoints() {
        const activeObjects = this.canvas.getActiveObjects();
        if (!activeObjects || activeObjects.length === 0) return;

        const objectsToDelete = new Set();
        const allPolygons = this.canvas.getObjects('polygon');

        activeObjects.forEach(obj => {
            if (obj.type !== 'circle') return;

            let connectionCount = 0;
            allPolygons.forEach(line => {
                if (line._poseId === obj._poseId && (line._startCircle === obj || line._endCircle === obj)) {
                    connectionCount++;
                }
            });

            if (connectionCount <= 1) {
                objectsToDelete.add(obj);
            }
        });

        if (objectsToDelete.size === 0) return;

        allPolygons.forEach(line => {
            if (objectsToDelete.has(line._startCircle) || objectsToDelete.has(line._endCircle)) {
                objectsToDelete.add(line);
            }
        });

        objectsToDelete.forEach(obj => this.canvas.remove(obj));

        this.canvas.discardActiveObject();
        this.canvas.renderAll();
        this.syncDimensionsToNode();
    }

    removeFilteredPose() {
        const filterIndex = parseInt(this.poseFilterInput.value, 10);

        const allCircles = this.canvas.getObjects('circle');
        const poseIds = [...new Set(allCircles.map(c => c._poseId))];
        poseIds.sort((a, b) => a - b);

        const objectsToRemove = new Set();

        if (filterIndex === -1) {
            this.canvas.getObjects().forEach(obj => objectsToRemove.add(obj));
            this.nextPoseId = 0;
        } else if (filterIndex >= 0 && filterIndex < poseIds.length) {
            const targetPoseId = poseIds[filterIndex];
            this.canvas.getObjects().forEach(obj => {
                if (obj._poseId === targetPoseId) {
                    objectsToRemove.add(obj);
                }
            });
        }

        if (objectsToRemove.size === 0) return;

        objectsToRemove.forEach(obj => this.canvas.remove(obj));
        this.poseFilterInput.value = "-1";
        this.applyPoseFilter(-1);
        this.canvas.renderAll();
        this.syncDimensionsToNode();
    }

    applyPoseFilter(filterIndex) {
        if (this.lockMode) return;

        const allCircles = this.canvas.getObjects('circle');
        const poseIds = [...new Set(allCircles.map(c => c._poseId))];
        poseIds.sort((a, b) => a - b);

        let targetPoseId = -1;
        if (filterIndex >= 0 && filterIndex < poseIds.length) {
            targetPoseId = poseIds[filterIndex];
        }

        this.canvas.getObjects().forEach(obj => {
            if (filterIndex === -1) {
                obj.set({
                    selectable: true,
                    evented: true
                });
            } else {
                if (obj._poseId === targetPoseId) {
                    obj.set({
                        selectable: true,
                        evented: true
                    });
                } else {
                    obj.set({
                        selectable: false,
                        evented: false
                    });
                }
            }
        });

        this.canvas.discardActiveObject();
        this.canvas.renderAll();
    }

    selectAll() {
        this.canvas.discardActiveObject();
        if (this.activeSelection) {
            this.activeSelection.forEach(obj => obj.set('stroke', obj.originalStroke));
        }

        const allCircles = this.canvas.getObjects('circle');
        if (allCircles.length > 0) {
            this.activeSelection = [...allCircles];
            this.activeSelection.forEach(obj => {
                obj.originalStroke = obj.stroke;
                obj.set('stroke', '#FFFF00');
            });
            this.canvas.renderAll();
        }
    }

    syncDimensionsToNode() {
        if (!this.node) return;

        const newWidth = Math.round(this.canvas.width);
        const newHeight = Math.round(this.canvas.height);

        this.node.setProperty("output_width_for_dwpose", newWidth);
        this.node.setProperty("output_height_for_dwpose", newHeight);

        const widthWidget = this.node.widgets?.find(w => w.name === "output_width_for_dwpose");
        if (widthWidget) {
            widthWidget.value = newWidth;
            if (widthWidget.callback) {
                widthWidget.callback(newWidth);
            }
            if (widthWidget.inputEl) {
                widthWidget.inputEl.value = newWidth;
            }
        }

        const heightWidget = this.node.widgets?.find(w => w.name === "output_height_for_dwpose");
        if (heightWidget) {
            heightWidget.value = newHeight;
            if (heightWidget.callback) {
                heightWidget.callback(newHeight);
            }
            if (heightWidget.inputEl) {
                heightWidget.inputEl.value = newHeight;
            }
        }

        this.node.setDirtyCanvas(true, true);
        if (app.graph) {
            app.graph.setDirtyCanvas(true, true);
        }
        if (app.canvas) {
            app.canvas.draw(true);
        }

        if (this.node.onPropertyChanged) {
            this.node.onPropertyChanged("output_width_for_dwpose", newWidth, this.node.properties.output_width_for_dwpose);
            this.node.onPropertyChanged("output_height_for_dwpose", newHeight, this.node.properties.output_height_for_dwpose);
        }
    }

    // Change: load pose data from the poses_datas property (no longer from the input connection)
    async loadFromPoseKeypoint() {
        try {
            // 1. Get data from the node's poses_datas property
            let poseData = this.node.properties?.poses_datas;
            
            if (!poseData || poseData.trim() === "") {
                alert("No valid poses_datas found. Please make sure this property has a value!");
                return;
            }

            // 2. Normalize the data format (handles both string and object formats)
            let poseJson = null;
            if (typeof poseData === "string") {
                poseJson = JSON.parse(poseData);
            } else if (Array.isArray(poseData) || typeof poseData === "object") {
                poseJson = poseData;
            }

            if (!poseJson) {
                alert("Invalid poses_datas format!");
                return;
            }

            // 3. Generate a data fingerprint to avoid duplicate updates
            const dataFingerprint = JSON.stringify(poseJson);
            if (this.lastPoseData === dataFingerprint) {
                alert("Pose data has not changed; no update needed!");
                return;
            }
            this.lastPoseData = dataFingerprint;

            // 4. Parse the pose data and load it onto the canvas
            
            // Extract the canvas size
            let canvasWidth = 512;
            let canvasHeight = 512;
            if (Array.isArray(poseJson) && poseJson[0]) {
                canvasWidth = poseJson[0].canvas_width || poseJson[0].width || 512;
                canvasHeight = poseJson[0].canvas_height || poseJson[0].height || 512;
            } else if (poseJson.width && poseJson.height) {
                canvasWidth = poseJson.width;
                canvasHeight = poseJson.height;
            }

            // Resize the canvas
            this.resizeCanvas(canvasWidth, canvasHeight);

            // Extract the people data
            let people = [];
            if (Array.isArray(poseJson) && poseJson[0]?.people) {
                people = poseJson[0].people;
            } else if (poseJson.people) {
                people = poseJson.people;
            }

            if (people.length > 0) {
                await this.setPose(people);
                this.saveToNode();
                this.syncDimensionsToNode();
            } else {
                alert("No valid body keypoint information found in poses_datas!");
            }

        } catch (error) {
            alert(`Failed to load pose data: ${error.message}`);
        }
    }
    
    fixLimbs() {
        if (this.lockMode) return;

        const allCircles = this.canvas.getObjects('circle');
        const poses = {};
        allCircles.forEach(circle => {
            const poseId = circle._poseId;
            if (!poses[poseId]) poses[poseId] = [];
            poses[poseId].push(circle);
        });

        // COCO 18 Keypoints
        // 0:Nose, 1:Neck, 2:R-Sho, 3:R-Elb, 4:R-Wr, 5:L-Sho, 6:L-Elb, 7:L-Wr
        // 8:R-Hip, 9:R-Knee, 10:R-Ank, 11:L-Hip, 12:L-Knee, 13:L-Ank
        // 14:R-Eye, 15:L-Eye, 16:R-Ear, 17:L-Ear

        // Symmetric pairs
        const symmetryPairs = [
            [2, 5], [3, 6], [4, 7],   // arms
            [8, 11], [9, 12], [10, 13], // legs
            [14, 15], [16, 17]        // face
        ];

        // Parent-child relations (used for extrapolation)
        // [Child, Parent, ReferenceParent] -> Child = Parent + (Parent - ReferenceParent) * ratio
        // For simplicity, we assume limb lengths are roughly equal
        const limbExtensions = [
            [4, 3, 2], [7, 6, 5],   // wrists
            [10, 9, 8], [13, 12, 11] // ankles
        ];

        Object.keys(poses).forEach(poseId => {
            const poseCircles = poses[poseId];
            const keypoints = new Array(18).fill(null);

            // 1. Fill in the points that currently exist
            poseCircles.forEach(c => {
                keypoints[c._id] = c;
            });

            // 2. Try to complete
            // We need to create a helper function to add new points
            const addMissingPoint = (id, x, y) => {
                if (keypoints[id]) return; // already exists

                const circle = new fabric.Circle({
                    left: x, top: y, radius: 5,
                    fill: `rgb(${connect_color[id] ? connect_color[id].join(", ") : '255,255,255'})`,
                    stroke: `rgb(${connect_color[id] ? connect_color[id].join(", ") : '255,255,255'})`,
                    originX: 'center', originY: 'center',
                    hasControls: false, hasBorders: false,
                    _id: id,
                    _poseId: parseInt(poseId)
                });
                
                this.canvas.add(circle);
                keypoints[id] = circle; // update the record
            };

            // Strategy A: symmetric completion
            const neck = keypoints[1];
            if (neck) {
                symmetryPairs.forEach(pair => {
                    const leftId = pair[1]; // the larger index is usually the left side (in the COCO definition 5,6,7 are left)
                    const rightId = pair[0];

                    const L = keypoints[leftId];
                    const R = keypoints[rightId];

                    if (L && !R) {
                        // has left but not right: add right
                        addMissingPoint(rightId, neck.left + (neck.left - L.left), L.top);
                    } else if (!L && R) {
                        // has right but not left: add left
                        addMissingPoint(leftId, neck.left + (neck.left - R.left), R.top);
                    }
                });
            }

            // Strategy B: limb extension (simple vector addition)
            // If elbow and shoulder exist but wrist is missing -> wrist = elbow + (elbow - shoulder)
            limbExtensions.forEach(rule => {
                const [target, p1, p2] = rule;
                if (!keypoints[target] && keypoints[p1] && keypoints[p2]) {
                    const P1 = keypoints[p1];
                    const P2 = keypoints[p2];
                    const vX = P1.left - P2.left;
                    const vY = P1.top - P2.top;
                    addMissingPoint(target, P1.left + vX, P1.top + vY);
                }
            });
        });

        // Regenerate the connecting lines
        const existingPolygons = this.canvas.getObjects('polygon');
        
        Object.keys(poses).forEach(poseIdStr => {
            const poseId = parseInt(poseIdStr);
            const posePoints = this.canvas.getObjects('circle').filter(c => c._poseId === poseId);
            const pointMap = {};
            posePoints.forEach(p => pointMap[p._id] = p);

            connect_keypoints.forEach(pair => {
                const start = pointMap[pair[0]];
                const end = pointMap[pair[1]];

                if (start && end) {
                    // Check whether the line already exists
                    const hasLine = existingPolygons.some(l => 
                        l._poseId === poseId && 
                        ((l._startCircle === start && l._endCircle === end) || 
                         (l._startCircle === end && l._endCircle === start))
                    );

                    if (!hasLine) {
                        // Create a new spindle-shaped polygon
                        const points = this.getFusiformPoints(
                            { x: start.left, y: start.top },
                            { x: end.left, y: end.top }
                        );

                        const polygon = new fabric.Polygon(points, {
                            fill: `rgba(${connect_color[pair[0]] ? connect_color[pair[0]].join(", ") : '255,255,255'}, 0.7)`,
                            strokeWidth: 0,
                            selectable: false,
                            evented: false,
                            lockMovementX: true,
                            lockMovementY: true,
                            lockRotation: true,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockSkewingX: true,
                            lockSkewingY: true,
                            hasControls: false,
                            hasBorders: false,
                            originX: 'center',
                            originY: 'center',
                            _startCircle: start,
                            _endCircle: end,
                            _poseId: poseId
                        });
                        this.canvas.add(polygon);
                        this.canvas.sendToBack(polygon); // make sure the line is below the points
                    }
                }
            });
        });
        
        this.canvas.requestRenderAll();
    }

    showPauseControls() {
        const pauseToolbar = this.pauseToolbar;
        if (!pauseToolbar) return;
        
        pauseToolbar.innerHTML = ""; // clear
        pauseToolbar.style.display = "flex"; // show

        // Status text
        const statusText = document.createElement("span");
        statusText.innerText = "⚠️ Run paused...";
        statusText.style.cssText = "color: #ffcc00; font-weight: bold; font-size: 12px; margin-right: 15px;";
        pauseToolbar.appendChild(statusText);

        // Continue button
        const btnContinue = document.createElement("button");
        btnContinue.innerText = "Continue";
        btnContinue.title = "Submit the current edits and continue the workflow";
        btnContinue.style.cssText = "background: #228be6; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;";
        
        btnContinue.onclick = async () => {
            try {
                btnContinue.innerText = "Submitting...";
                btnContinue.disabled = true;
                
                // Get the latest pose data
                const poseData = this.serializeJSON();
                
                // Send to the backend
                await api.fetchApi("/openpose/update_pose", {
                    method: "POST",
                    body: JSON.stringify({ node_id: this.node.id, pose_data: poseData })
                });
                
                // Hide the control area and reset the state
                pauseToolbar.style.display = "none";
                this.node.is_paused = false;
                
                // Automatically close the editor window
                if (this.panel) {
                    this.panel.close();
                }
            } catch (e) {
                alert("Submit failed: " + e.message);
                btnContinue.innerText = "Retry";
                btnContinue.disabled = false;
            }
        };

        // Stop button
        const btnCancel = document.createElement("button");
        btnCancel.innerText = "Stop";
        btnCancel.title = "Cancel the current workflow";
        btnCancel.style.cssText = "background: #fa5252; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold;";

        btnCancel.onclick = async () => {
            if(!confirm("Are you sure you want to stop the current workflow?")) return;
            
            try {
                await api.fetchApi("/openpose/cancel", {
                    method: "POST",
                    body: JSON.stringify({ node_id: this.node.id })
                });
                // Hide the control area and reset the state
                pauseToolbar.style.display = "none";
                this.node.is_paused = false;
                
                // Automatically close the editor window
                if (this.panel) {
                    this.panel.close();
                }
            } catch (e) {
                alert("Cancel failed: " + e.message);
            }
        };

        pauseToolbar.appendChild(btnContinue);
        pauseToolbar.appendChild(btnCancel);
    }

    constructor(panel, node, initialData = {}) {
        this.panel = panel;
        this.node = node;
        this.nextPoseId = 0;
        
        // Store the initial state, used for reset
        this.initialPoseData = null;
        this.initialBackgroundImage = null;

        this.panel.style.overflow = 'hidden';
        this.setPanelStyle();

        const rootHtml = `
                <canvas class="openpose-editor-canvas" />
                <div class="canvas-drag-overlay" />
                <input bind:this={fileInput} class="openpose-file-input" type="file" accept=".json" />
                <input class="openpose-bg-file-input" type="file" accept="image/jpeg,image/png,image/webp" /> 
        `;

        const container = this.panel.addHTML(rootHtml, "openpose-container");
        // Use absolute-positioning layout, leaving room for the top header and bottom footer
        // Add extra bottom space for two rows of buttons (50px -> 90px)
        container.style.cssText = "position: absolute; top: 40px; bottom: 100px; left: 10px; right: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center;";
        
        // Make sure the footer is at the bottom and does not cover the content
        this.panel.footer.style.position = "absolute";
        this.panel.footer.style.bottom = "0";
        this.panel.footer.style.left = "0";
        this.panel.footer.style.right = "0";
        this.panel.footer.style.height = "90px"; // increase height
        this.panel.footer.style.padding = "5px 10px";
        this.panel.footer.style.boxSizing = "border-box";
        this.panel.footer.style.overflow = "hidden";
        this.panel.footer.style.display = "flex";
        this.panel.footer.style.flexDirection = "column"; // change to vertical layout
        this.panel.footer.style.justifyContent = "flex-end"; // align to bottom
        this.panel.footer.style.gap = "5px";

        // Create two toolbar containers
        this.pauseToolbar = document.createElement("div");
        this.pauseToolbar.className = "pause-toolbar";
        this.pauseToolbar.style.cssText = "width: 100%; height: 40px; display: none; align-items: center; justify-content: center; gap: 10px; background: rgba(50, 50, 50, 0.5); border-radius: 4px;";
        
        this.mainToolbar = document.createElement("div");
        this.mainToolbar.className = "main-toolbar";
        this.mainToolbar.style.cssText = "width: 100%; height: 40px; display: flex; align-items: center; justify-content: space-between;";

        this.panel.footer.appendChild(this.pauseToolbar);
        this.panel.footer.appendChild(this.mainToolbar);

        container.style.pointerEvents = 'none';

        this.canvasWidth = this.node.properties.output_width_for_dwpose || 512;
        this.canvasHeight = this.node.properties.output_height_for_dwpose || 512;

        this.canvasElem = container.querySelector(".openpose-editor-canvas");
        this.canvasElem.width = this.canvasWidth;
        this.canvasElem.height = this.canvasHeight;
        this.canvasElem.style.cssText = "margin: 0.25rem; border-radius: 0.25rem; border: 0.5px solid;";

        this.canvas = this.initCanvas(this.canvasElem);
        this.canvas.wrapperEl.style.pointerEvents = 'auto';

        this.fileInput = container.querySelector(".openpose-file-input");
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", this.onLoad.bind(this));

        // Redefine the addButton method so that it adds to mainToolbar
        this.panel.addButton = (name, callback) => {
            const btn = document.createElement("button");
            btn.innerText = name;
            btn.onclick = callback;
            btn.style.cssText = "background: #222; color: #ddd; border: 1px solid #444; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;";
            this.mainToolbar.appendChild(btn);
            return btn;
        };

        this.panel.addButton("Add", () => {
            const default_pose_keypoints_2d = [];
            DEFAULT_KEYPOINTS.forEach(pt => {
                default_pose_keypoints_2d.push(pt[0], pt[1], 1.0);
            });

            this.addPose(default_pose_keypoints_2d);
            this.saveToNode();
            this.syncDimensionsToNode();
        });

        this.panel.addButton("Delete Point", () => { this.deleteSelectedPoints(); this.saveToNode(); });
        this.panel.addButton("Clear", () => { this.removeFilteredPose(); this.saveToNode(); });
        this.panel.addButton("Reset", () => {
            if (this.initialPoseData) {
                this.loadJSON(this.initialPoseData);
                
                if (this.initialBackgroundImage) {
                    this.node.setProperty("backgroundImage", this.initialBackgroundImage);
                    // Reload the background image
                    const imageUrl = `/view?filename=${this.initialBackgroundImage}&type=input&t=${Date.now()}`;
                    fabric.Image.fromURL(imageUrl, (img) => {
                        if (!img || !img.width) return;
                        img.set({
                            scaleX: this.canvas.width / img.width,
                            scaleY: this.canvas.height / img.height,
                            opacity: 0.6,
                            selectable: false,
                            evented: false,
                        });
                        this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas));
                    }, { crossOrigin: 'anonymous' });
                } else {
                    this.canvas.setBackgroundImage(null, this.canvas.renderAll.bind(this.canvas));
                    this.node.setProperty("backgroundImage", "");
                }
                
                this.saveToNode();
                this.syncDimensionsToNode();
            } else {
                // If there is no initial state, fall back to the original logic
                this.resetCanvas();
                this.node.setProperty("backgroundImage", "");
    
                const default_pose_keypoints_2d = [];
                DEFAULT_KEYPOINTS.forEach(pt => {
                    default_pose_keypoints_2d.push(pt[0], pt[1], 1.0);
                });
                const defaultPeople = [{ "pose_keypoints_2d": default_pose_keypoints_2d }];
    
                this.setPose(defaultPeople);
    
                this.saveToNode();
                this.syncDimensionsToNode();
            }
        });
        
        this.panel.addButton("Save", () => {
            this.save();
            this.syncDimensionsToNode();
        });
        this.panel.addButton("Load", () => this.load());
        this.panel.addButton("Select All", () => {
            const selectableCircles = this.canvas.getObjects('circle').filter(obj => obj.selectable);

            if (selectableCircles.length > 0) {
                this.canvas.discardActiveObject();

                const selection = new fabric.ActiveSelection(selectableCircles, {
                    canvas: this.canvas,
                });
                this.canvas.setActiveObject(selection);

                this.canvas.fire('selection:created', { target: selection });

                this.canvas.renderAll();
            }
        });
        
        // Add the Complete button
        this.panel.addButton("Complete", () => {
            this.fixLimbs();
            this.saveToNode();
        });

        this.bgFileInput = container.querySelector(".openpose-bg-file-input");
        this.bgFileInput.style.display = "none";
        this.bgFileInput.addEventListener("change", (e) => this.loadBackgroundImage(e));
        this.panel.addButton("Background", () => this.bgFileInput.click());

        const setupDimensionInput = (label, value, callback) => {
            const lbl = document.createElement("label");
            lbl.innerHTML = label;
            lbl.style.cssText = "font-family: Arial; padding: 0 0.5rem; color: #ccc; display: none;"; // hide label
            const input = document.createElement("input");
            input.style.cssText = "background: #1c1c1c; color: #aaa; width: 60px; border: 1px solid #444; display: none;"; // hide input
            input.type = "number";
            input.min = "64";
            input.max = "4096";
            input.step = "64";
            input.value = value;
            input.addEventListener("change", (e) => {
                const newValue = parseInt(e.target.value);
                if (!isNaN(newValue)) {
                    callback(newValue);
                    this.syncDimensionsToNode();
                }
            });
            this.mainToolbar.appendChild(lbl);
            this.mainToolbar.appendChild(input);
            return input;
        };

        this.widthInput = setupDimensionInput("", this.canvasWidth, (value) => {
            this.resizeCanvas(value, this.canvasHeight);
            this.saveToNode();
        });
        this.heightInput = setupDimensionInput("", this.canvasHeight, (value) => {
            this.resizeCanvas(this.canvasWidth, value);
            this.saveToNode();
        });

        this.widthInput.addEventListener("input", (e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0) {
                this.canvasWidth = val;
                this.canvas.setWidth(val);
                this.canvas.renderAll();
            }
        });
        this.heightInput.addEventListener("input", (e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val > 0) {
                this.canvasHeight = val;
                this.canvas.setHeight(val);
                this.canvas.renderAll();
            }
        });

        const lbl = document.createElement("label");
        lbl.innerHTML = "Person";
        lbl.style.cssText = "font-family: Arial; padding: 0 0.5rem; color: #ccc;";

        this.poseFilterInput = document.createElement("input");
        this.poseFilterInput.style.cssText = "background: #1c1c1c; color: #aaa; width: 60px; border: 1px solid #444;";
        this.poseFilterInput.type = "number";
        this.poseFilterInput.min = "-1";
        this.poseFilterInput.step = "1";
        this.poseFilterInput.value = this.node.properties.poseFilterIndex || "-1";
        
        this.poseFilterInput.addEventListener("input", () => {
            const filterValue = parseInt(this.poseFilterInput.value, 10);
            this.applyPoseFilter(filterValue);
            this.node.setProperty("poseFilterIndex", filterValue);
            this.syncDimensionsToNode();
        });

        this.mainToolbar.appendChild(lbl);
        this.mainToolbar.appendChild(this.poseFilterInput);

        setTimeout(() => {
            // Check whether we are in the paused state; if so, show the control buttons
            if (this.node.is_paused) {
                this.showPauseControls();
            }

            const savedFilterIndex = this.node.properties.poseFilterIndex;
            if (savedFilterIndex !== undefined && savedFilterIndex !== null) {
                this.poseFilterInput.value = savedFilterIndex;
                this.applyPoseFilter(savedFilterIndex);
            }
            
            const bgImageFilename = this.node.properties.backgroundImage;
            if (bgImageFilename) {
                // Save the initial background image settings
                this.initialBackgroundImage = bgImageFilename;
                
                const imageUrl = `/view?filename=${bgImageFilename}&type=input&t=${Date.now()}`;
                fabric.Image.fromURL(imageUrl, (img) => {
                    if (!img || !img.width) {
                        return;
                    }
                    img.set({
                        scaleX: this.canvas.width / img.width,
                        scaleY: this.canvas.height / img.height,
                        opacity: 0.6,
                        selectable: false,
                        evented: false,
                    });
                    this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas));
                }, { crossOrigin: 'anonymous' });
            }
            
            if (this.node.properties.poses_datas && this.node.properties.poses_datas.trim() !== "") {
                // Save the initial pose data
                this.initialPoseData = this.node.properties.poses_datas;
                
                const error = this.loadJSON(this.node.properties.poses_datas);
                if (error) {
                    this.resizeCanvas(this.canvasWidth, this.canvasHeight);
                    this.setPose(DEFAULT_KEYPOINTS);
                }
            } else {
                this.resizeCanvas(this.canvasWidth, this.canvasHeight);

                const default_pose_keypoints_2d = [];
                DEFAULT_KEYPOINTS.forEach(pt => {
                    default_pose_keypoints_2d.push(pt[0], pt[1], 1.0);
                });
                const defaultPeople = [{ "pose_keypoints_2d": default_pose_keypoints_2d }];

                this.setPose(defaultPeople);
                this.syncDimensionsToNode();
                
                // Save as the initial state even for the default pose
                this.initialPoseData = JSON.stringify({
                    width: this.canvasWidth,
                    height: this.canvasHeight,
                    people: defaultPeople
                });
            }
            // Removed the code that started the auto-detect timer
        }, 0);

        const keyHandler = this.onKeyDown.bind(this);
        document.addEventListener("keydown", this.onKeyDown.bind(this));
        this.panel.onClose = () => { 
            document.removeEventListener("keydown", keyHandler);
            this.syncDimensionsToNode();
            // Removed the code that stopped the timer
        };
    }

    // Removed the auto-detect related timer methods
    setPanelStyle() {
        this.panel.style.transform = `translate(-50%,-50%)`;
        this.panel.style.margin = `0px 0px`;
        // Force the highest stacking level again
        this.panel.style.zIndex = "2147483647";
        this.panel.style.position = "fixed";
    }

    onKeyDown(e) {
        if (e.key === "z" && e.ctrlKey) {
            this.undo()
            e.preventDefault();
            e.stopImmediatePropagation();
        }
        else if (e.key === "y" && e.ctrlKey) {
            this.redo()
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    getFusiformPoints(start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        let length = Math.sqrt(dx * dx + dy * dy);
        if (length === 0) length = 1; // avoid division by zero

        // Midpoint
        const midX = (start.x + end.x) / 2;
        const midY = (start.y + end.y) / 2;

        // Normal vector (normalized): (-dy, dx)
        const nx = -dy / length;
        const ny = dx / length;

        // Set the maximum width of the spindle
        // Can be fixed, or adjusted dynamically by length (e.g. 15% of the length, but not more than 14px)
        const maxWidth = 14; 
        // const calculatedWidth = Math.min(length * 0.15, maxWidth); 
        const halfWidth = maxWidth / 2;

        // Generate the four vertices: start -> side 1 -> end -> side 2
        return [
            { x: start.x, y: start.y },
            { x: midX + nx * halfWidth, y: midY + ny * halfWidth },
            { x: end.x, y: end.y },
            { x: midX - nx * halfWidth, y: midY - ny * halfWidth }
        ];
    }

    addPose(pose_keypoints_2d = []) {
        const poseId = this.nextPoseId;
        const circles = {};
        const lines = [];

        for (let i = 0; i < 18; i++) {
            const x = pose_keypoints_2d[i * 3];
            const y = pose_keypoints_2d[i * 3 + 1];
            const confidence = pose_keypoints_2d[i * 3 + 2];

            if (confidence === 0) {
                continue;
            }

            const circle = new fabric.Circle({
                left: x, top: y, radius: 5,
                fill: `rgb(${connect_color[i] ? connect_color[i].join(", ") : '255,255,255'})`,
                stroke: `rgb(${connect_color[i] ? connect_color[i].join(", ") : '255,255,255'})`,
                originX: 'center', originY: 'center',
                hasControls: false, hasBorders: false,
                _id: i,
                _poseId: poseId
            });
            circles[i] = circle;
        }
		
        connect_keypoints.forEach((pair, i) => {
            const startCircle = circles[pair[0]];
            const endCircle = circles[pair[1]];
            if (!startCircle || !endCircle) return;

            // Compute the initial spindle-shaped vertices
            const points = this.getFusiformPoints(
                { x: startCircle.left, y: startCircle.top }, 
                { x: endCircle.left, y: endCircle.top }
            );

            // Use Polygon instead of Line
            const line = new fabric.Polygon(points, {
                fill: `rgba(${connect_color[pair[0]] ? connect_color[pair[0]].join(", ") : '255,255,255'}, 0.7)`,
                strokeWidth: 0, // no stroke needed, since the shape is drawn with fill
                selectable: false,
                evented: false,// Core: lock all movement/rotation/scaling/skewing
				lockMovementX: true,
				lockMovementY: true,
				lockRotation: true,
				lockScalingX: true,
				lockScalingY: true,
				lockSkewingX: true,
				lockSkewingY: true,
				// Extra: hide the controls and border (completely prevents accidental operations)
				hasControls: false,
				hasBorders: false,
				
                originX: 'center',
                originY: 'center',
                _startCircle: startCircle,
                _endCircle: endCircle,
                _poseId: poseId
            });

            lines.push(line);
        });

        this.nextPoseId++;
        this.canvas.add(...lines, ...Object.values(circles));

        return new Promise(resolve => {
            setTimeout(() => {
                // The setTimeout here is mainly to make sure coordinates are updated once after rendering (if necessary)
                // For Polygon, the initial points are already correct, so this can be simplified
                this.canvas.requestRenderAll();
                resolve();
            }, 0);
        });
    }
	
	
    async setPose(people) {
		
		
        const tempBackgroundImage = this.canvas.backgroundImage;
        this.canvas.clear();
        this.canvas.backgroundImage = tempBackgroundImage;
        this.canvas.backgroundColor = "#000";
        this.nextPoseId = 0;

        const posePromises = people.map(person => this.addPose(person.pose_keypoints_2d || []));

        await Promise.all(posePromises);
		
		// New: fallback check - force all connecting lines to stay locked
		this.canvas.getObjects('polygon').forEach(line => {
			line.set({
				selectable: false,
				evented: false,
				lockMovementX: true,
				lockMovementY: true,
				lockRotation: true,
				lockScalingX: true,
				lockScalingY: true,
				lockSkewingX: true,
				lockSkewingY: true,
				hasControls: false,
				hasBorders: false
			});
		});

        this.canvas.getObjects().forEach(obj => obj.setCoords());
        this.canvas.renderAll();
        this.saveToNode();

    }

    calcResolution(width, height) {
        const viewportWidth = window.innerWidth / 2.25;
        const viewportHeight = window.innerHeight * 0.75;
        const ratio = Math.min(viewportWidth / width, viewportHeight / height);
        return { width: width * ratio, height: height * ratio }
    }

    resizeCanvas(width, height) {

        if (width != null && height != null) {
            this.canvasWidth = width;
            this.canvasHeight = height;

            this.widthInput.value = `${width}`
            this.heightInput.value = `${height}`

            this.canvas.setWidth(width);
            this.canvas.setHeight(height);
        }

        const rectPanel = this.canvasElem.closest('.openpose-container').getBoundingClientRect();

        if (rectPanel.width == 0 && rectPanel.height == 0) {
            setTimeout(() => {
                this.resizeCanvas();
            }, 100)
            return;
        }

        // Reimplemented scaling logic: always scale via CSS transform, keeping the Canvas internal resolution unchanged
        const availableWidth = rectPanel.width;
        const availableHeight = rectPanel.height;
        
        // Compute the scale ratio, leaving a bit of padding
        const padding = 20; // add a bit of padding
        const scaleX = (availableWidth - padding) / this.canvasWidth;
        const scaleY = (availableHeight - padding) / this.canvasHeight;
        
        // Keep the aspect ratio; the 1.0 limit is removed, allowing unlimited enlargement to fill the window
        const scale = Math.min(scaleX, scaleY); 

        // Get the Fabric wrapper element (usually the parent of canvasElem)
        // A more rigorous way to get it
        const wrapperEl = this.canvas.wrapperEl || this.canvasElem.parentElement;

        if (wrapperEl) {
            // The wrapper size must be reset, otherwise it takes up actual pixel space, breaking flex centering or stretching the container
            // But fabricjs needs the wrapper to have the correct size to handle events...
            // Trick: make the wrapper absolutely centered, then apply transform
            
            wrapperEl.style.position = "absolute";
            wrapperEl.style.left = "50%";
            wrapperEl.style.top = "50%";
            wrapperEl.style.width = `${this.canvasWidth}px`;
            wrapperEl.style.height = `${this.canvasHeight}px`;
            // Use translate(-50%, -50%) for absolute centering, then layer the scale on top
            wrapperEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
            wrapperEl.style.transformOrigin = "center center"; // the origin does not matter after translate, but keep it consistent
            
            // Make sure the inner canvas also fills 100% of the wrapper
            this.canvasElem.style.width = "100%";
            this.canvasElem.style.height = "100%";
            // Upper canvas (the layer fabric uses for interaction)
            if (this.canvas.upperCanvasEl) {
                this.canvas.upperCanvasEl.style.width = "100%";
                this.canvas.upperCanvasEl.style.height = "100%";
            }
        }
    }

    undo() {
        if (this.undo_history.length > 0) {
            this.lockMode = true;
            if (this.undo_history.length > 1)
                this.redo_history.push(this.undo_history.pop());
            const content = this.undo_history[this.undo_history.length - 1];
            this.canvas.loadFromJSON(content, () => {
                this.canvas.renderAll();
                this.lockMode = false;
            });
        }
    }

    redo() {
        if (this.redo_history.length > 0) {
            this.lockMode = true;
            const content = this.redo_history.pop();
            this.undo_history.push(content);
            this.canvas.loadFromJSON(content, () => {
                this.canvas.renderAll();
                this.lockMode = false;
            });
        }
    }

    initCanvas(elem) {
        const canvas = new fabric.Canvas(elem, {
            backgroundColor: '#000',
            preserveObjectStacking: true,
            selection: true,
            fireRightClick: true,  // allow right click to fire events
            stopContextMenu: true  // try to block the context menu
        });

        // Force-disable the context menu (better compatibility)
        // Bind to wrapperEl to cover the whole canvas area
        if (canvas.wrapperEl) {
            canvas.wrapperEl.addEventListener('contextmenu', function(e) {
                e.preventDefault();
                return false;
            });
        }

        // Add mouse wheel zoom
        canvas.on('mouse:wheel', function(opt) {
            var delta = opt.e.deltaY;
            var zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.1) zoom = 0.1; // minimum zoom changed to be smaller
            
            // Compute the zoom center point (accounting for CSS scaling)
            // getBoundingClientRect returns the actual rendered area after the CSS transform
            const rect = canvas.getElement().getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                // Compute the mouse position ratio relative to the Canvas element
                // then map it to pixel coordinates inside the Canvas
                const x = (opt.e.clientX - rect.left) * (canvas.width / rect.width);
                const y = (opt.e.clientY - rect.top) * (canvas.height / rect.height);
                canvas.zoomToPoint({ x: x, y: y }, zoom);
            } else {
                 canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            }

            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        // Add mouse drag-to-pan for the canvas (hold Alt, or middle/right button)
        let isDragging = false;
        let lastPosX, lastPosY;
        let wasSelectionEnabled = true;

        canvas.on('mouse:down', function(opt) {
            var evt = opt.e;
            // Change: removed right-button drag (evt.button === 2); only Alt+left button or middle button (evt.button === 1) remain
            if (evt.altKey || evt.button === 1) { 
                isDragging = true;
                wasSelectionEnabled = canvas.selection;
                canvas.selection = false;
                lastPosX = evt.clientX;
                lastPosY = evt.clientY;
                canvas.defaultCursor = 'grabbing';
                canvas.setCursor('grabbing');
                
                // Prevent default behavior and bubbling to avoid triggering the browser's autoscroll mode
                if (evt.preventDefault) evt.preventDefault();
                if (evt.stopPropagation) evt.stopPropagation();
            }
        });

        canvas.on('mouse:move', function(opt) {
            if (isDragging) {
                var e = opt.e;
                var vpt = canvas.viewportTransform;
                
                // Compute the movement delta (accounting for CSS scaling)
                const rect = canvas.getElement().getBoundingClientRect();
                let scaleX = 1;
                let scaleY = 1;
                
                if (rect.width > 0 && rect.height > 0) {
                     scaleX = canvas.width / rect.width;
                     scaleY = canvas.height / rect.height;
                }
                
                vpt[4] += (e.clientX - lastPosX) * scaleX;
                vpt[5] += (e.clientY - lastPosY) * scaleY;
                
                canvas.requestRenderAll();
                lastPosX = e.clientX;
                lastPosY = e.clientY;
            }
        });

        canvas.on('mouse:up', function(opt) {
            // on mouse up we want to recalculate new interaction
            // for all objects, so we call setViewportTransform
            if(isDragging) {
                canvas.setViewportTransform(canvas.viewportTransform);
                isDragging = false;
                canvas.selection = wasSelectionEnabled;
                canvas.defaultCursor = 'default';
                canvas.setCursor('default');
            }
        });
        
        // Disable the context menu to make right-button dragging easier
        const upperCanvasEl = canvas.upperCanvasEl;
        upperCanvasEl.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
        // Key: forcibly prevent the default behavior on middle-button press and take over the drag state manually
        // Because Fabric.js may not fire the middle-button mouse:down event under some configurations
        upperCanvasEl.addEventListener('mousedown', function(e) {
            if (e.button === 1) { // middle button
                e.preventDefault();
                e.stopPropagation();
                
                // Manually trigger the drag state
                isDragging = true;
                wasSelectionEnabled = canvas.selection;
                canvas.selection = false;
                lastPosX = e.clientX;
                lastPosY = e.clientY;
                canvas.defaultCursor = 'grabbing';
                canvas.setCursor('grabbing');
                
                return false;
            }
        });
        
        // Addition: make sure releasing the middle button ends the drag (bound to window in case the mouse leaves the canvas)
        window.addEventListener('mouseup', function(e) {
            if (isDragging && e.button === 1) {
                canvas.setViewportTransform(canvas.viewportTransform);
                isDragging = false;
                canvas.selection = wasSelectionEnabled;
                canvas.defaultCursor = 'default';
                canvas.setCursor('default');
            }
        });

        const updateLines = (target) => {
            if (!target || target.type !== 'circle') return;
            // Find all associated polygon connecting lines
            canvas.getObjects('polygon').forEach(polygon => {
                if (polygon._startCircle === target || polygon._endCircle === target) {
                    const start = polygon._startCircle.getCenterPoint();
                    const end = polygon._endCircle.getCenterPoint();
                    // Use the OpenPosePanel instance method to compute the new vertices
                    // Note: 'this' here refers to the OpenPosePanel instance
                    const newPoints = this.getFusiformPoints(start, end);
                    polygon.set({ points: newPoints });
                    // Polygon usually does not need setCoords after updating points, but just in case
                    polygon.setCoords();
                }
            });
        };
        canvas.on('object:moving', (e) => updateLines(e.target));

        canvas.on('selection:created', (e) => {
            const selection = e.target;

            if (selection.type === 'activeSelection') {
                const selectableObjects = selection.getObjects().filter(obj => obj.selectable);

                if (selectableObjects.length < selection.size()) {
                    canvas.discardActiveObject();

                    if (selectableObjects.length > 1) {
                        const correctSelection = new fabric.ActiveSelection(selectableObjects, { canvas: canvas });
                        canvas.setActiveObject(correctSelection);
                    } else if (selectableObjects.length === 1) {
                        canvas.setActiveObject(selectableObjects[0]);
                    }
                }
            }
        });

        canvas.on("object:modified", (e) => {
            if (this.lockMode || !e.target) return;

            const target = e.target;
            if (target.type === 'activeSelection') {
                const groupMatrix = target.calcTransformMatrix();
                target.forEachObject(obj => {
                    if (obj.type === 'circle') {
                        const point = new fabric.Point(obj.left, obj.top);
                        const finalPos = fabric.util.transformPoint(point, groupMatrix);
                        obj.set({
                            left: finalPos.x,
                            top: finalPos.y
                        });
                        obj.setCoords();
                    }
                });
            }

            const currentStateJson = this.serializeJSON();

            this.undo_history.push(currentStateJson);
            this.redo_history.length = 0;
            this.loadJSON(currentStateJson);
            this.saveToNode();
        });

        return canvas;
    }

    saveToNode() {
        const newPoseJson = this.serializeJSON();

        this.node.setProperty("poses_datas", newPoseJson);

        if (this.node.jsonWidget) {
            this.node.jsonWidget.value = newPoseJson;
        }

        this.uploadAndSetImages();
    }

    async captureCanvasClean() {
        this.lockMode = true;

        // Save the current viewport state
        const originalViewportTransform = this.canvas.viewportTransform;
        // Reset the viewport to get the full unscaled image
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

        const backgroundImage = this.canvas.backgroundImage;
        
        // Save the original opacity of the image object
        const imageOpacities = new Map();

        try {
            if (backgroundImage) {
                backgroundImage.visible = false;
            }

            this.canvas.getObjects("image").forEach((img) => {
                imageOpacities.set(img, img.opacity);
                img.opacity = 0;
            });

            this.canvas.discardActiveObject();
            this.canvas.renderAll();

            const dataURL = this.canvas.toDataURL({
                multiplier: 1,
                format: 'png'
            });
            const blob = dataURLToBlob(dataURL);
            return blob;
        } catch (e) {
            throw e;
        } finally {
            if (backgroundImage) {
                backgroundImage.visible = true;
            }

            this.canvas.getObjects("image").forEach((img) => {
                if (imageOpacities.has(img)) {
                    img.opacity = imageOpacities.get(img);
                } else {
                    img.opacity = 1; // restore the default
                }
            });
            
            // Restore the viewport state
            this.canvas.viewportTransform = originalViewportTransform;
            this.canvas.renderAll();

            this.lockMode = false;
        }
    }

    async captureCanvasCombined() {
        this.lockMode = true;

        // Save the current viewport state
        const originalViewportTransform = this.canvas.viewportTransform;
        // Reset the viewport to get the full unscaled image
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

        const backgroundImage = this.canvas.backgroundImage;
        let originalOpacity = 1.0;

        try {
            if (backgroundImage) {
                originalOpacity = backgroundImage.opacity;
                backgroundImage.opacity = 1.0;
            }

            this.canvas.discardActiveObject();
            this.canvas.renderAll();

            const dataURL = this.canvas.toDataURL({
                multiplier: 1,
                format: 'png'
            });
            const blob = dataURLToBlob(dataURL);
            return blob;
        } catch (e) {
            throw e;
        } finally {
            if (backgroundImage) {
                backgroundImage.opacity = originalOpacity;
            }
            
            // Restore the viewport state
            this.canvas.viewportTransform = originalViewportTransform;
            this.canvas.renderAll();

            this.lockMode = false;
        }
    }


    async uploadAndSetImages() {
        try {
            const cleanBlob = await this.captureCanvasClean();
            if (!cleanBlob || cleanBlob.size === 0) {
                return;
            }

            const cleanFilename = `ComfyUI_OpenPose_${this.node.id}.png`;

            const bodyClean = new FormData();
            bodyClean.append("image", cleanBlob, cleanFilename);
            bodyClean.append("overwrite", "true");

            const respClean = await fetch("/upload/image", { method: "POST", body: bodyClean });
            if (respClean.status !== 200) {
                throw new Error(`Failed to upload clean pose image: ${respClean.statusText}`);
            }
            const dataClean = await respClean.json();
            await this.node.setImage(dataClean.name);

            if (this.canvas.backgroundImage) {
                const combinedBlob = await this.captureCanvasCombined();
                const combinedFilename = `ComfyUI_OpenPose_${this.node.id}_combined.png`;

                const bodyCombined = new FormData();
                bodyCombined.append("image", combinedBlob, combinedFilename);
                bodyCombined.append("overwrite", "true");

                const respCombined = await fetch("/upload/image", { method: "POST", body: bodyCombined });
            }

        } catch (error) {
            alert(error);
        }
    }


    resetCanvas() {
        this.canvas.clear();
        this.canvas.setBackgroundImage(null, this.canvas.renderAll.bind(this.canvas));
        this.canvas.backgroundColor = "#000";
        this.nextPoseId = 0;
    }

    load() {
        this.fileInput.value = null;
        this.fileInput.click();
    }

    async onLoad(e) {
        const file = this.fileInput.files[0];
        const text = await readFileToText(file);
        const error = await this.loadJSON(text);
        if (error != null) {
            app.ui.dialog.show(error);
        }
        else {
            this.saveToNode();
        }
    }

    serializeJSON() {
        // Key fix: before serializing, save the current viewport transform (zoom and pan)
        const originalViewportTransform = this.canvas.viewportTransform;
        
        // Temporarily reset the viewport to its default state (no zoom, no offset)
        // so that the object coordinates we get are the original absolute coordinates, unaffected by zoom
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

        // Recompute the coordinates of all objects to match the reset viewport
        // Note: calcTransformMatrix or setCoords may need to be called,
        // but fabric usually handles this automatically when getting properties, unless we manipulate the internal matrix directly.
        // To be safe, we iterate over the objects and call setCoords (it may not be necessary after a viewport change, but in some versions it is)
        // Actually, a simpler way is to get the original coordinates of the objects directly, but Fabric object coordinates are relative to the canvas.
        // When viewportTransform changes, the rendered position of objects changes, but the left/top values themselves are based on the canvas coordinate system.
        // If we modified an object's position while zoomed, Fabric automatically converts mouse coordinates back to canvas coordinates.
        // So in theory, as long as the viewport is reset, the exported data is clean.
        
        const allCircles = this.canvas.getObjects('circle');
        const poses = {};
        allCircles.forEach(circle => {
            const poseId = circle._poseId;
            if (!poses[poseId]) {
                poses[poseId] = [];
            }
            poses[poseId].push(circle);
        });

        const people = [];
        Object.keys(poses).sort((a, b) => a - b).forEach(poseId => {
            const poseCircles = poses[poseId];

            const keypoints_2d = new Array(18 * 3).fill(0);

            poseCircles.forEach(circle => {
                const pointId = circle._id;
                // Get the center point (the viewport is reset at this point, so coordinates are the original canvas coordinates)
                const center = circle.getCenterPoint();
                keypoints_2d[pointId * 3] = center.x;
                keypoints_2d[pointId * 3 + 1] = center.y;
                keypoints_2d[pointId * 3 + 2] = 1.0;
            });

            people.push({
                "pose_keypoints_2d": keypoints_2d
            });
        });

        const json = JSON.stringify({
            "width": this.canvas.width,
            "height": this.canvas.height,
            "people": people
        }, null, 4);

        // Restore the original viewport transform
        this.canvas.viewportTransform = originalViewportTransform;

        return json;
    }

    async loadBackgroundImage(e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const body = new FormData();
            body.append("image", file);
            body.append("overwrite", "true");

            const resp = await fetch("/upload/image", { method: "POST", body: body });
            if (resp.status !== 200) {
                throw new Error(`Failed to upload background image: ${resp.statusText}`);
            }
            const data = await resp.json();
            const filename = data.name;

            this.node.setProperty("backgroundImage", filename);
            if (this.node.bgImageWidget) {
                this.node.bgImageWidget.value = filename;
            }

            const imageUrl = `/view?filename=${filename}&type=input&subfolder=${data.subfolder}&t=${Date.now()}`;
            fabric.Image.fromURL(imageUrl, (img) => {
                img.set({
                    scaleX: this.canvas.width / img.width,
                    scaleY: this.canvas.height / img.height,
                    opacity: 0.6,
                    selectable: false,
                    evented: false,
                });
                this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas));

                this.uploadAndSetImages();

            }, { crossOrigin: 'anonymous' });

        } catch (error) {
            alert(error);
        } finally {
            e.target.value = '';
        }
    }

    save() {
        const json = this.serializeJSON()
        const blob = new Blob([json], {
            type: "application/json"
        });
        const filename = "pose-" + Date.now().toString() + ".json"
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    loadJSON(text) {
        try {

            const json = JSON.parse(text);

            if (!json["width"] || !json["height"]) {
                return 'JSON is missing width or height properties.';
            }
            this.resizeCanvas(json["width"], json["height"]);

            const people = json["people"] || [];

            let allKeypointsForCheck = [];
            people.forEach(person => {
                const keypoints_2d = person.pose_keypoints_2d || [];
                for (let i = 0; i < keypoints_2d.length; i += 3) {
                    if (keypoints_2d[i + 2] > 0) {
                        allKeypointsForCheck.push([keypoints_2d[i], keypoints_2d[i + 1]]);
                    }
                }
            });

            if (allKeypointsForCheck.length > 0) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                allKeypointsForCheck.forEach(pt => {
                    if (pt[0] < minX) minX = pt[0];
                    if (pt[0] > maxX) maxX = pt[0];
                    if (pt[1] < minY) minY = pt[1];
                    if (pt[1] > maxY) maxY = pt[1];
                });

                const canvasWidth = this.canvas.getWidth();
                const canvasHeight = this.canvas.getHeight();
                let offsetX = 0, offsetY = 0;

                if (maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight) {
                    const poseWidth = maxX - minX;
                    const poseHeight = maxY - minY;
                    offsetX = -minX + (canvasWidth - poseWidth) / 2;
                    offsetY = -minY + (canvasHeight - poseHeight) / 2;

                    people.forEach(person => {
                        const keypoints_2d = person.pose_keypoints_2d || [];
                        for (let i = 0; i < keypoints_2d.length; i += 3) {
                            if (keypoints_2d[i + 2] > 0) {
                                keypoints_2d[i] += offsetX;
                                keypoints_2d[i + 1] += offsetY;
                            }
                        }
                    });
                }
            }

            this.setPose(people);

            if (this.poseFilterInput) {
                const currentFilterIndex = parseInt(this.poseFilterInput.value, 10);
                if (!isNaN(currentFilterIndex)) {
                    this.applyPoseFilter(currentFilterIndex);
                }
            }

            return null;
        } catch (e) {
            return `Failed to parse JSON: ${e.message}`;
        }
    }

}

app.registerExtension({
    name: "Nui.OpenPoseEditor",
    setup() {
        api.addEventListener("openpose_node_pause", (event) => {
            const nodeId = event.detail.node_id;
            const currentPose = event.detail.current_pose; // Get the latest pose data sent by the backend
            const currentBackgroundImage = event.detail.current_background_image; // Get the latest background image

            const node = app.graph.getNodeById(nodeId);
            if (!node) return;

            
            // Mark the node as paused
            node.is_paused = true;

            // 0. Key fix: if the backend sent the latest pose data, force-update the node property and the editor
            if (currentPose && currentPose.trim() !== "") {
                node.setProperty("poses_datas", currentPose);
                
                // If the editor instance exists, load the new data directly
                if (node.openPosePanel) {
                    node.openPosePanel.loadJSON(currentPose);
                }
            }
            
            // 0.5 Key fix: if the backend sent the latest background image, force-update it
            if (currentBackgroundImage && currentBackgroundImage.trim() !== "") {
                node.setProperty("backgroundImage", currentBackgroundImage);
                
                if (node.openPosePanel) {
                    // Force-refresh the background image
                    const imageUrl = `/view?filename=${currentBackgroundImage}&type=input&t=${Date.now()}`;
                    fabric.Image.fromURL(imageUrl, (img) => {
                        if (!img || !img.width) return;
                        img.set({
                            scaleX: node.openPosePanel.canvas.width / img.width,
                            scaleY: node.openPosePanel.canvas.height / img.height,
                            opacity: 0.6,
                            selectable: false,
                            evented: false,
                        });
                        node.openPosePanel.canvas.setBackgroundImage(img, node.openPosePanel.canvas.renderAll.bind(node.openPosePanel.canvas));
                    }, { crossOrigin: 'anonymous' });
                }
            }

            // 1. Make sure the editor is open
            if (node.openWidget && node.openWidget.callback) {
                // If the panel is not open, call the callback to open it
                if (!node.openPosePanel || !node.openPosePanel.panel || !document.body.contains(node.openPosePanel.panel)) {
                    node.openWidget.callback();
                }
            }

            // 2. Add control buttons at the bottom of the panel
            if (node.openPosePanel && node.openPosePanel.panel) {
                // Call the encapsulated method
                node.openPosePanel.showPauseControls();
            }
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "Nui.OpenPoseEditor") {
            return
        }

        fabric.Object.prototype.transparentCorners = false;
        fabric.Object.prototype.cornerColor = '#108ce6';
        fabric.Object.prototype.borderColor = '#108ce6';
        fabric.Object.prototype.cornerSize = 10;

        const makePanelDraggable = function (panelElement) {
            let isDragging = false;
            let startX, startY;
            let initialLeft, initialTop;

            // Try to find the title bar; if there is none, use the whole panel but restrict the clickable area
            // ComfyUI/LiteGraph panels usually have no standard header class, but the content is at the top
            // We implement this by listening to mousedown and checking the click position
            
            panelElement.addEventListener("mousedown", (e) => {
                const rect = panelElement.getBoundingClientRect();

                // 1. Exclude the bottom-right resize handle area (e.g. 30x30 pixels)
                if (e.clientX > rect.right - 30 && e.clientY > rect.bottom - 30) {
                    return; 
                }

                // 2. Exclude interactive elements (Input, Button, Canvas, etc.)
                const target = e.target;
                const tagName = target.tagName.toUpperCase();
                
                if (tagName === 'INPUT' || 
                    tagName === 'BUTTON' || 
                    tagName === 'SELECT' || 
                    tagName === 'TEXTAREA' ||
                    tagName === 'CANVAS') { 
                    return;
                }
                
                // Exclude the Fabric container (to avoid accidentally touching the Canvas edge)
                if (target.classList.contains('canvas-container')) {
                    return;
                }

                // 3. Allow dragging (as long as it is not one of the above, clicking any blank area of the panel can drag)
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;

                // Key: when dragging starts, convert the transform to absolute left/top coordinates
                // This avoids the computational complexity of transform: translate(-50%, -50%)
                const computedStyle = window.getComputedStyle(panelElement);
                const currentLeft = rect.left;
                const currentTop = rect.top;

                // Keep fixed positioning while dragging, remove the transform, and use left/top directly
                panelElement.style.transform = "none";
                panelElement.style.position = "fixed";
                panelElement.style.left = currentLeft + "px";
                panelElement.style.top = currentTop + "px";
                panelElement.style.margin = "0";
                // Make sure the stacking level is still highest while dragging
                panelElement.style.zIndex = "2147483647"; 
                
                initialLeft = currentLeft;
                initialTop = currentTop;

                document.body.style.userSelect = "none";
                panelElement.style.cursor = "move";
            });

            window.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                
                e.preventDefault();
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;
                
                panelElement.style.left = (initialLeft + deltaX) + "px";
                panelElement.style.top = (initialTop + deltaY) + "px";
            });

            window.addEventListener("mouseup", () => {
                if (isDragging) {
                    isDragging = false;
                    document.body.style.userSelect = "";
                    panelElement.style.cursor = "default";
                }
            });
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            if (!this.properties) {
                this.properties = {};
            }
            if (!this.properties.poses_datas) {
                this.properties.poses_datas = "";
            }

            this.serialize_widgets = true;

            this.imageWidget = this.widgets.find(w => w.name === "image");
            this.imageWidget.callback = this.showImage.bind(this);
            this.imageWidget.disabled = true;

           
            this.bgImageWidget = this.addWidget("text", "backgroundImage", this.properties.backgroundImage || "", () => { }, {});
            if (this.bgImageWidget && this.bgImageWidget.inputEl) {
                this.bgImageWidget.inputEl.style.display = "none";
            }
			
			this.jsonWidget = this.addWidget("text", "poses_datas", this.properties.poses_datas, "poses_datas");
            if (this.jsonWidget && this.jsonWidget.inputEl) {
                this.jsonWidget.inputEl.style.display = "none";
            } else {
            }
			// ========== Key change: add the "Apply Pose" button (loads from poses_datas) ==========
            this.applyPoseWidget = this.addWidget("button", "Apply Pose", "image", async () => {
                try {
                    // Check whether the editor is open
                    if (this.openPosePanel) {
                        // If the editor is open, call the pose-loading method directly
                        await this.openPosePanel.loadFromPoseKeypoint();
                    } else {
                        // If the editor is not open, read the data directly from the poses_datas property
                        let poseData = this.properties?.poses_datas;
                        
                        if (!poseData || poseData.trim() === "") {
                            alert("No valid poses_datas found. Please make sure this property has a value!");
                            return;
                        }

                        // Normalize the data format
                        let poseJson = null;
                        if (typeof poseData === "string") {
                            poseJson = JSON.parse(poseData);
                        } else if (Array.isArray(poseData) || typeof poseData === "object") {
                            poseJson = poseData;
                        }

                        if (!poseJson) {
                            alert("Invalid poses_datas format!");
                            return;
                        }

                        // Extract width and height info
                        let canvasWidth = 512;
                        let canvasHeight = 512;
                        if (Array.isArray(poseJson) && poseJson[0]) {
                            canvasWidth = poseJson[0].canvas_width || poseJson[0].width || 512;
                            canvasHeight = poseJson[0].canvas_height || poseJson[0].height || 512;
                        } else if (poseJson.width && poseJson.height) {
                            canvasWidth = poseJson.width;
                            canvasHeight = poseJson.height;
                        }

                        // Update the node's width and height properties
                        this.setProperty("output_width_for_dwpose", canvasWidth);
                        this.setProperty("output_height_for_dwpose", canvasHeight);
                        
                        // Update the corresponding input boxes
                        const widthWidget = this.widgets?.find(w => w.name === "output_width_for_dwpose");
                        if (widthWidget) {
                            widthWidget.value = canvasWidth;
                            if (widthWidget.callback) widthWidget.callback(canvasWidth);
                            if (widthWidget.inputEl) widthWidget.inputEl.value = canvasWidth;
                        }

                        const heightWidget = this.widgets?.find(w => w.name === "output_height_for_dwpose");
                        if (heightWidget) {
                            heightWidget.value = canvasHeight;
                            if (heightWidget.callback) heightWidget.callback(canvasHeight);
                            if (heightWidget.inputEl) heightWidget.inputEl.value = canvasHeight;
                        }

                        // Extract the people data and save it to the node (make sure the data format is correct)
                        let people = [];
                        if (Array.isArray(poseJson) && poseJson[0]?.people) {
                            people = poseJson[0].people;
                        } else if (poseJson.people) {
                            people = poseJson.people;
                        }

                        if (people.length > 0) {
                            // Serialize the pose data and save it to the node
                            const poseJsonData = JSON.stringify({
                                "width": canvasWidth,
                                "height": canvasHeight,
                                "people": people
                            }, null, 4);
                            
                            this.setProperty("poses_datas", poseJsonData);
                            if (this.jsonWidget) {
                                this.jsonWidget.value = poseJsonData;
                            }
                            
                            // Trigger a node refresh
                            this.setDirtyCanvas(true, true);
                            if (app.graph) app.graph.setDirtyCanvas(true, true);
                            if (app.canvas) app.canvas.draw(true);
                            
                        } else {
                            alert("No valid body keypoint information found in poses_datas!");
                        }
                    }
                } catch (error) {
                    alert(`Failed to apply pose: ${error.message}`);
                }
            });
            this.applyPoseWidget.serialize = false;
			
            this.openWidget = this.addWidget("button", "Edit Pose", "image", () => {
                const graphCanvas = LiteGraph.LGraphCanvas.active_canvas
                if (graphCanvas == null)
                    return;

                // [Change] Removed the pose_keypoint input check; now checks the poses_datas property instead
                if (this.properties.poses_datas && this.properties.poses_datas.trim() !== "") {
                } else {
                }

                const panel = graphCanvas.createPanel("Pose Editor", { closable: true });
                panel.node = this;
                panel.classList.add("openpose-editor");
                
                // Set a larger default size
                panel.style.width = "900px";
                panel.style.height = "800px";
                // Ultimate fix: use a separate overlay container
                let mask = document.getElementById("openpose-mask-container");
                if (!mask) {
                    mask = document.createElement("div");
                    mask.id = "openpose-mask-container";
                    mask.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
                    document.body.appendChild(mask);
                }

                // Force-move the panel into the overlay and set the highest-priority styles
                mask.appendChild(panel);
                
                // Make sure the panel's own styles are correct and enable interaction
                panel.style.position = "fixed";
                panel.style.top = "50%";
                panel.style.left = "50%";
                panel.style.transform = "translate(-50%, -50%)";
                panel.style.zIndex = "2147483647"; 
                panel.style.pointerEvents = "auto";
                panel.style.boxShadow = "0 0 50px rgba(0,0,0,0.5)"; // add a shadow to improve visibility

                this.openPosePanel = new OpenPosePanel(panel, this);
                makePanelDraggable(panel, this.openPosePanel);
                
                // Make sure the resize handle follows too
                const resizer = document.createElement("div");
                resizer.style.width = "10px";
                resizer.style.height = "10px";
                resizer.style.background = "#888";
                resizer.style.position = "absolute";
                resizer.style.right = "0";
                resizer.style.bottom = "0";
                resizer.style.cursor = "se-resize";
                panel.appendChild(resizer);

                // Add a keep-alive mechanism: prevent LiteGraph or other scripts from moving the panel away
                // Check every 500ms; if the panel is not in the mask, move it back
                const keepAliveInterval = setInterval(() => {
                    if (panel && mask && panel.parentElement !== mask) {
                         mask.appendChild(panel);
                    }
                    // If the panel is closed (usually removed from the DOM), clear the timer
                    // Note: LiteGraph's close may remove the element, so we need to detect it
                    if (!document.body.contains(mask)) {
                        clearInterval(keepAliveInterval);
                    }
                }, 500);
                
                // Hijack panel.close to clean up the mask and the timer
                const originalClose = panel.close;
                panel.close = function() {
                    clearInterval(keepAliveInterval);
                    if (originalClose) originalClose.call(panel);
                    if (mask && mask.parentNode) {
                        mask.parentNode.removeChild(mask);
                    }
                };

                let isResizing = false;
                resizer.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    isResizing = true;
                });

                document.addEventListener("mousemove", (e) => {
                    if (!isResizing) return;
                    const rect = panel.getBoundingClientRect();
                    panel.style.width = `${e.clientX - rect.left}px`;
                    panel.style.height = `${e.clientY - rect.top}px`;
                });

                document.addEventListener("mouseup", () => {
                    isResizing = false;
                    this.openPosePanel.resizeCanvas()
                });
            });
            this.openWidget.serialize = false;
            
            // ====================================================

            requestAnimationFrame(async () => {
                if (this.imageWidget.value) {
                    await this.setImage(this.imageWidget.value);
                }
            });
        }

        const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			
			if (onExecuted) {
				onExecuted.apply(this, arguments);
			}


			let dataUpdated = false;

			if (message && message.poses_datas && message.poses_datas.length > 0) {
				const poseData = message.poses_datas[0];
				if (poseData && poseData.trim() !== "") {
					this.setProperty("poses_datas", poseData);	
					
					const poseShape = message.dw_pose_shape && message.dw_pose_shape[0] ? message.dw_pose_shape[0] : [];
					if (poseShape.length >= 4) {
						const height = poseShape[1];
						const width = poseShape[2];
						
						this.setProperty("output_width_for_dwpose", width);
						this.setProperty("output_height_for_dwpose", height);
						
						const widthWidget = this.widgets?.find(w => w.name === "output_width_for_dwpose");
						if (widthWidget) {
							widthWidget.value = width;
							widthWidget.callback?.(width);
						}
						
						const heightWidget = this.widgets?.find(w => w.name === "output_height_for_dwpose");
						if (heightWidget) {
							heightWidget.value = height;
							heightWidget.callback?.(height);
						}
					}
					
					if (this.imageWidget) {
						this.imageWidget.value = poseData;
					}
					if (this.jsonWidget) {
						this.jsonWidget.value = poseData;
					}
					
					
					requestAnimationFrame(async () => {
						if (this.imageWidget.value) {
							await this.setImage(message.editdPose[0]);
						}
					});
					
					dataUpdated = true;
				}
			}

				if (message && message.backgroundImage && message.backgroundImage.length > 0) {
					const bgImage = message.backgroundImage[0];
					if (bgImage && bgImage.trim() !== "") {
						this.setProperty("backgroundImage", bgImage);
						if (this.bgImageWidget) {
							this.bgImageWidget.value = bgImage;
						}
						dataUpdated = true;
					}
				}
				
				if (message && message.inputPose && message.inputPose.length > 0) {
					const bgImage = message.inputPose[0];
					if (bgImage && bgImage.trim() !== "") {
						this.setProperty("backgroundImage", bgImage);
						if (this.bgImageWidget) {
							this.bgImageWidget.value = bgImage;
						}
						dataUpdated = true;
					}
				}

			if (dataUpdated && this.openPosePanel) {

				if (this.properties.poses_datas && this.properties.poses_datas.trim() !== "") {
					const error = this.openPosePanel.loadJSON(this.properties.poses_datas);
				}

				if (this.properties.backgroundImage && this.properties.backgroundImage.trim() !== "") {
					const imageUrl = `/view?filename=${this.properties.backgroundImage}&type=input&t=${Date.now()}`;
					fabric.Image.fromURL(imageUrl, (img) => {
						if (!img || !img.width) {
							return;
						}
						img.set({
							scaleX: this.openPosePanel.canvas.width / img.width,
							scaleY: this.openPosePanel.canvas.height / img.height,
							opacity: 0.6,
							selectable: false,
							evented: false,
						});
						this.openPosePanel.canvas.setBackgroundImage(img, this.openPosePanel.canvas.renderAll.bind(this.openPosePanel.canvas));
					}, { crossOrigin: 'anonymous' });
				}
			}

			if (dataUpdated) {
				app.graph.setDirtyCanvas(true, true);
				this.onResize?.(this.size);
				app.canvas.draw(true);
			}

			this.setDirtyCanvas(true, true);
		}
        nodeType.prototype.showImage = async function (name) {
            let folder_separator = name.lastIndexOf("/");
            let subfolder = "";
            if (folder_separator > -1) {
                subfolder = name.substring(0, folder_separator);
                name = name.substring(folder_separator + 1);
            }
            const img = await loadImageAsync(`/view?filename=${name}&type=input&subfolder=${subfolder}&t=${Date.now()}`);
            this.imgs = [img];
            app.graph.setDirtyCanvas(true);
        }

        nodeType.prototype.setImage = async function (name) {
            this.imageWidget.value = name;
            await this.showImage(name);
        }

        const baseOnPropertyChanged = nodeType.prototype.onPropertyChanged;
        nodeType.prototype.onPropertyChanged = function (property, value, prev) {
            if (property === "poses_datas" && this.jsonWidget) {
                this.jsonWidget.value = value;
            } else if (baseOnPropertyChanged) {
                baseOnPropertyChanged.call(this, property, value, prev);
            }
        };

    }
});
