# ComfyUI OpenPose Editor (DocKr Optimized)

An enhanced OpenPose editor node for ComfyUI. It was co-developed by a friend from our group chat and me, and published by me. It fixes interaction issues and adds advanced features such as smart limb completion and in-workflow pause editing.

## ✨ Key Features

*   **Visual pose editing**: Open a canvas directly inside ComfyUI to drag, add, and delete body keypoints.
*   **Smart limb completion**: The **"Complete"** button infers and fills in missing symmetric limbs or joints from the existing keypoints (based on body symmetry and skeleton logic).
*   **Improved interaction**:
    *   ✅ **Fixed middle-mouse-button dragging**: Natively supports dragging the canvas while holding the middle mouse button, resolving browser compatibility issues.
    *   Supports `Alt + Left Click` to drag the canvas.
    *   Supports smooth zooming with the mouse wheel.
*   **Deep workflow integration**:
    *   **Pause/continue mechanism**: Receives a pause signal while the workflow is running and opens the editor for adjustments. Click "Continue" to send the modified pose back to the backend and resume generation.
    *   **Automatic sync**: Syncs the editor canvas size to the node outputs (`width`, `height`) in real time, making it easy to connect to nodes like DWPose.
    *   **Background image reference**: Supports uploading a background image to help align poses.
*   **Data management**:
    *   Supports saving/loading Pose JSON files.
    *   Supports undo (`Ctrl+Z`) / redo (`Ctrl+Y`).
    *   Supports loading and applying pose data directly from the node's `poses_datas` property.

## 📸 Screenshots

### 1. Deep workflow integration
![Workflow](assets/workflow.png)

### 2. Pause editing mode
![Pause Mode](assets/pause_mode.png)

## 🛠️ Installation

### Method 1: Using ComfyUI Manager (recommended)
Simply search for `OpenPose Editor (DocKr)` and install it.

### Method 2: Manual installation

1.  **Go to the node directory**
    Open a terminal (CMD/PowerShell) and go to your ComfyUI `custom_nodes` directory:
    ```bash
    cd /path/to/ComfyUI/custom_nodes
    ```

2.  **Clone the repository**
    ```bash
    git clone https://github.com/DocWorkBox/ComfyUI-OpenPose-Editor-DocKr.git
    ```

3.  **Install dependencies**
    Go to the plugin directory and install the required dependencies:
    ```bash
    cd ComfyUI-OpenPose-Editor-DocKr
    pip install -r requirements.txt
    ```
    > **Note**: If you are using the ComfyUI Portable build, run the pip command with the Python from the portable environment:
    > ```bash
    > ..\..\python_embeded\python.exe -m pip install -r requirements.txt
    > ```

4.  **Restart ComfyUI**
    After restarting, you can find `Nui.OpenPoseEditor` in the node list.

## 📖 Usage Guide

1.  **Add the node**: Double-click an empty area of the ComfyUI canvas and search for `OpenPoseEditor` (under the `Nui` category).
2.  **Open the editor**: Click the **"Edit Pose"** button on the node.
3.  **Controls**:
    *   **Move keypoints**: Drag with the left mouse button.
    *   **Pan the canvas**: Hold the **middle mouse button** or `Alt + Left Click` and drag.
    *   **Zoom the canvas**: Scroll the mouse wheel.
    *   **Select all**: Click the "Select All" button in the toolbar.
4.  **Special features**:
    *   **Complete**: If you have drawn only half of the body (e.g. left arm and left leg), click "Complete" to try to automatically generate the matching limbs on the right side.
    *   **Apply Pose**: If the node input is connected to pose data, or the `poses_datas` property has a value, click "Apply Pose" to load it into the editor.

## 🤝 Contributing and Feedback

This project aims to provide a more stable and easier-to-use OpenPose editing experience. If you run into problems or have suggestions, feel free to open an issue.
