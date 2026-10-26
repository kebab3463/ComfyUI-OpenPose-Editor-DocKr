import os.path
import folder_paths
from nodes import LoadImage, interrupt_processing
import json
import time
import numpy as np
import torch
import cv2
import math
import random
from PIL import Image
from server import PromptServer
from aiohttp import web

# ====================================================================================================
# API route handlers: pause and resume
# ====================================================================================================
PAUSED_NODES = {}

routes = PromptServer.instance.routes

class AnyType(str):
    """A special type that always compares equal to any value."""

    def __ne__(self, __value: object) -> bool:
        return False

any_type = AnyType("*")

@routes.post('/openpose/update_pose')
async def openpose_update_pose(request):
    try:
        json_data = await request.json()
        node_id = str(json_data.get('node_id')) # force to string
        pose_data = json_data.get('pose_data')
        
        if node_id in PAUSED_NODES:
            PAUSED_NODES[node_id] = {
                'status': 'resume',
                'data': pose_data
            }
            return web.json_response({"status": "success", "message": "Resuming execution"})
        else:
             return web.json_response({"status": "error", "message": "Node not paused"}, status=400)
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

@routes.post('/openpose/cancel')
async def openpose_cancel(request):
    try:
        json_data = await request.json()
        node_id = str(json_data.get('node_id')) # force to string
        
        if node_id in PAUSED_NODES:
            PAUSED_NODES[node_id] = {
                'status': 'cancel'
            }
            return web.json_response({"status": "success", "message": "Cancelling execution"})
        else:
             return web.json_response({"status": "error", "message": "Node not paused"}, status=400)
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

# ====================================================================================================
# Constants
# ====================================================================================================
LIMB_SEQ = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]]

COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]]


# [Final integrated version] OpenPose Editor node
# ====================================================================================================
class OpenPoseEditor:
    _last_fingerprints = {}

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("STRING", { "default": "" }),
            },
            "optional": {
                "pose_image": ("IMAGE",),
                "pose_point": ("POSE_KEYPOINT",),
                "prev_image": ("IMAGE",),
                "bridge_anything": (any_type,),  # changed to IMAGE type
                "output_width_for_dwpose": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64}),
                "output_height_for_dwpose": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 64}),
                "scale_for_xinsr_for_dwpose": ("BOOLEAN", {"default": True}),
                "stop_for_edit": ("BOOLEAN", {"default": False, "label_on": "Pause for Edit", "label_off": "No Pause"}),
            },
            "hidden": {
                "backgroundImage": ("STRING", {"multiline": False}),
                "poses_datas": ("STRING", {"multiline": True, "rows": 10, "placeholder": "Pose JSON data will be stored here..."}),
                "unique_id": "UNIQUE_ID",
            }
        }
    
    # [Ultimate fix] IS_CHANGED: fully compatible with all parameters, including the IMAGE-type bridge_anything
    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        """
        Accepts arbitrary parameters:
        - *args receives positional arguments
        - **kwargs receives all keyword arguments
        Completely avoids the "unexpected keyword argument" warning
        """
        # 1. Extract core parameters (compatible with any way of passing them)
        image = kwargs.get("image", args[0] if args else "")
        output_width_for_dwpose = kwargs.get("output_width_for_dwpose", 512)
        output_height_for_dwpose = kwargs.get("output_height_for_dwpose", 512)
        scale_for_xinsr_for_dwpose = kwargs.get("scale_for_xinsr_for_dwpose", True)
        stop_for_edit = kwargs.get("stop_for_edit", False)
        
        backgroundImage = kwargs.get("backgroundImage", "")
        poses_datas = kwargs.get("poses_datas", "")
        
        # Hash IMAGE-type parameters (using memory address + shape)
        def get_image_hash(img_tensor):
            if img_tensor is None:
                return 0
            try:
                # Combine memory address + tensor shape to ensure uniqueness
                return hash(f"{id(img_tensor)}_{str(img_tensor.shape)}")
            except:
                return hash(id(img_tensor))
        
        bridge_anything_hash = get_image_hash(kwargs.get("bridge_anything"))
        prev_image_hash = get_image_hash(kwargs.get("prev_image"))
        pose_image_hash = get_image_hash(kwargs.get("pose_image"))
        pose_hash = hash(str(kwargs.get("pose_point"))) if kwargs.get("pose_point") else 0

        # 2. Generate a unique fingerprint (force the node to run every time, includes all parameters)
        timestamp = str(time.time() * 1000)
        random_str = str(random.randint(0, 999999))
        
        fingerprint = (
            f"{image}-{pose_hash}-{pose_image_hash}-{prev_image_hash}-{bridge_anything_hash}-"
            f"{output_width_for_dwpose}-{output_height_for_dwpose}-{scale_for_xinsr_for_dwpose}-{stop_for_edit}-"
            f"{timestamp}-{random_str}"
        )
        
        cls._last_fingerprints[fingerprint] = True
        return fingerprint

    # Output definitions
    RETURN_TYPES = ("IMAGE", "IMAGE","INT","INT",)
    RETURN_NAMES = ("dw_pose_image", "dw_comb_image","dw_pose_image_width","dw_pose_image_height")
    FUNCTION = "get_images"
    CATEGORY = "image"
    
    # Convert POSE_KEYPOINT to JSON
    def pose_point_to_json(self, pose_point, image_tensor):
        if not pose_point or not isinstance(pose_point, list):
            return ""
        
        if image_tensor.shape[0] == 0:
            return ""
        
        image_height = image_tensor.shape[1]
        image_width = image_tensor.shape[2]
        
        processed_people = []
        for result_dict in pose_point:
            people_in_dict = result_dict.get("people", [])
            for person in people_in_dict:
                original_keypoints = person.get("pose_keypoints_2d", [])
                body_keypoints = [0.0] * 54 
                num_points_to_copy = min(18, len(original_keypoints) // 3)
                for i in range(num_points_to_copy):
                    base_idx = i * 3
                    x = original_keypoints[base_idx]
                    y = original_keypoints[base_idx + 1]
                    confidence = original_keypoints[base_idx + 2]
                    if confidence > 0:
                        absolute_x = x * image_width
                        absolute_y = y * image_height
                        body_keypoints[base_idx] = absolute_x
                        body_keypoints[base_idx + 1] = absolute_y
                        body_keypoints[base_idx + 2] = confidence
                processed_people.append({
                    "pose_keypoints_2d": body_keypoints
                })
        
        data_to_save = {
            "width": int(image_width),
            "height": int(image_height),
            "people": processed_people
        }
        return json.dumps(data_to_save, indent=4)
    
    # Render DWPose
    def render_dw_pose(self, pose_json, width, height, scale_for_xinsr):
        if not pose_json or not pose_json.strip():
            return np.zeros((height, width, 3), dtype=np.uint8)
        try:
            data = json.loads(pose_json)
        except json.JSONDecodeError:
            return np.zeros((height, width, 3), dtype=np.uint8)

        target_w, target_h = width, height
        original_w, original_h = data.get('width', target_w), data.get('height', target_h)
        scale_x, scale_y = target_w / original_w, target_h / original_h

        canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)
        people = data.get('people', [])
        if not people:
            return canvas

        BASE_RESOLUTION_SIDE = 512.0
        base_thickness = 2.0
        target_max_side = max(target_w, target_h)
        scale_factor = target_max_side / BASE_RESOLUTION_SIDE
        scaled_joint_radius = int(max(1, base_thickness * scale_factor))
        scaled_stickwidth = scaled_joint_radius

        if scale_for_xinsr:
            xinsr_stick_scale = 1 if target_max_side < 500 else min(2 + (target_max_side // 1000), 7)
            scaled_stickwidth *= xinsr_stick_scale

        for person in people:
            keypoints_flat = person.get('pose_keypoints_2d', [])
            keypoints = [ (int(keypoints_flat[i] * scale_x), int(keypoints_flat[i+1] * scale_y)) if keypoints_flat[i+2] > 0 else None for i in range(0, len(keypoints_flat), 3) ]
            
            for limb_indices, color in zip(LIMB_SEQ, COLORS):
                k1_idx, k2_idx = limb_indices[0] - 1, limb_indices[1] - 1
                if k1_idx >= len(keypoints) or k2_idx >= len(keypoints): continue
                p1, p2 = keypoints[k1_idx], keypoints[k2_idx]
                if p1 is None or p2 is None: continue
                
                Y, X = np.array([p1[0], p2[0]]), np.array([p1[1], p2[1]])
                mX, mY = np.mean(X), np.mean(Y)
                length = np.sqrt((X[0] - X[1])**2 + (Y[0] - Y[1])**2)
                angle = math.degrees(math.atan2(X[0] - X[1], Y[0] - Y[1]))
                
                polygon = cv2.ellipse2Poly((int(mY), int(mX)), (int(length / 2), scaled_stickwidth), int(angle), 0, 360, 1)
                cv2.fillConvexPoly(canvas, polygon, [int(c * 0.6) for c in color])

            for i, keypoint in enumerate(keypoints):
                if keypoint is None: continue
                if i >= len(COLORS): continue
                cv2.circle(canvas, keypoint, scaled_joint_radius, COLORS[i], thickness=-1)
        
        return cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)

    # Main function: handles bridge_anything (IMAGE type)
    def get_images(self, image, output_width_for_dwpose, output_height_for_dwpose, scale_for_xinsr_for_dwpose, 
                    backgroundImage, poses_datas, bridge_anything=None, prev_image=None, pose_image=None, pose_point=None, 
                    stop_for_edit=False, unique_id=None):
        
        # Safety check: make sure the core string parameters are not None
        if backgroundImage is None:
            backgroundImage = ""
        if poses_datas is None:
            poses_datas = ""

        # Clear cache
        if hasattr(folder_paths, 'cache') and isinstance(folder_paths.cache, dict):
            folder_paths.cache.clear()
        
        # Handle bridge_anything (new: save as a temporary file)
        if bridge_anything is not None and bridge_anything.shape[0] > 0:
            try:
                bridge_np = (bridge_anything[0].cpu().numpy() * 255).astype(np.uint8)
                bridge_pil = Image.fromarray(bridge_np)
                temp_dir = folder_paths.get_input_directory()
                bridge_filename = f"openpose_bridge_temp_{int(time.time() * 1000)}.png"
                bridge_filepath = os.path.join(temp_dir, bridge_filename)
                bridge_pil.save(bridge_filepath)
                # Optionally use the bridge as the background image
                # backgroundImage = bridge_filename
            except Exception as e:
                pass
        
        # 1. Convert pose_point to JSON
        converted_pose_json = ""
        if pose_point is not None and pose_image is not None:
            converted_pose_json = self.pose_point_to_json(pose_point, pose_image)
            if converted_pose_json:
                try:
                    pose_json = json.loads(converted_pose_json)
                    output_width_for_dwpose = pose_json.get("width", output_width_for_dwpose)
                    output_height_for_dwpose = pose_json.get("height", output_height_for_dwpose)
                except json.JSONDecodeError:
                    pass
	
        # 2. Save pose_image as a temporary file
        if pose_image is not None and pose_image.shape[0] > 0:
            try:
                pose_image_np = (pose_image[0].cpu().numpy() * 255).astype(np.uint8)
                pose_image_pil = Image.fromarray(pose_image_np)
                temp_dir = folder_paths.get_input_directory()
                bg_filename = f"openpose_lg_temp_{int(time.time() * 1000)}.png"
                bg_filepath = os.path.join(temp_dir, bg_filename)
                pose_image_pil.save(bg_filepath)
            except Exception as e:
                pass
        else:
            pass
            
        # 3. Save prev_image as a temporary file
        ld_filepath= None
        if prev_image is not None and prev_image.shape[0] > 0:
            try:
                prev_image_np = (prev_image[0].cpu().numpy() * 255).astype(np.uint8)
                prev_image_pil = Image.fromarray(prev_image_np)
                temp_dir = folder_paths.get_input_directory()
                ld_filename = f"openpose_ld_temp_{int(time.time() * 1000)}.png"
                ld_filepath = os.path.join(temp_dir, ld_filename)
                prev_image_pil.save(ld_filepath)
                backgroundImage = ld_filename
            except Exception as e:
                pass
        else:
            pass
        
        # 4. Update poses_datas (key fix: make sure pose data obtained from the input connection is used)
        if converted_pose_json:
            poses_datas = converted_pose_json

        # ============================================================
        # Pause/breakpoint logic (Stop for Edit)
        # ============================================================
        if stop_for_edit and unique_id:
            node_str_id = str(unique_id) # force to string
            
            # Initialize the pause state
            # Key fix: put the current poses_datas (possibly just updated from the input connection) into the state
            # so that if the frontend queries the state, or the backend needs to know the current data, it is available
            PAUSED_NODES[node_str_id] = {'status': 'waiting', 'initial_data': poses_datas}
            
            # Send the pause message to the frontend
            # Key fix: also send the latest pose data to the frontend so it can refresh the editor
            # and send the latest background image path as well
            PromptServer.instance.send_sync("openpose_node_pause", {
                "node_id": node_str_id, 
                "current_pose": poses_datas,  # carries the latest pose data
                "current_background_image": backgroundImage # carries the latest background image path
            })
            
            # Blocking loop
            while True:
                if node_str_id not in PAUSED_NODES:
                    # Abnormal case: state lost
                    break
                    
                state = PAUSED_NODES[node_str_id]
                status = state.get('status')
                
                if status == 'resume':
                    # Get the new data returned by the frontend
                    new_pose_data = state.get('data')
                    if new_pose_data:
                        poses_datas = new_pose_data
                        # Try to update the size
                        try:
                            pd = json.loads(new_pose_data)
                            output_width_for_dwpose = pd.get("width", output_width_for_dwpose)
                            output_height_for_dwpose = pd.get("height", output_height_for_dwpose)
                        except:
                            pass
                    # Clean up the state
                    del PAUSED_NODES[node_str_id]
                    break
                
                elif status == 'cancel':
                    del PAUSED_NODES[node_str_id]
                    # Interrupt execution the way ComfyUI recommends
                    interrupt_processing()
                    return (torch.zeros(1, 512, 512, 3), {}, torch.zeros(1, 512, 512, 3)) # return empty data to prevent an immediate error
                
                time.sleep(0.1)
            
        # --- Output 1: pure DWPose render ---
        dw_pose_np = self.render_dw_pose(poses_datas, output_width_for_dwpose, output_height_for_dwpose, scale_for_xinsr_for_dwpose)
        dw_pose_image = torch.from_numpy(dw_pose_np.astype(np.float32) / 255.0).unsqueeze(0).clone()
        
        # Save the DWPose render
        dw_bg_filename = ""
        try:
            dw_pose_image_pil = Image.fromarray(dw_pose_np)
            temp_dir = folder_paths.get_input_directory()
            dw_bg_filename = f"openpose_dw_bg_temp_{int(time.time() * 1000)}.png"
            dw_bg_filepath = os.path.join(temp_dir, dw_bg_filename)
            dw_pose_image_pil.save(dw_bg_filepath)
        except Exception as e:
            pass

        # --- Output 2: DWPose + background composite ---
        dw_combined_image = dw_pose_image.clone()
        if backgroundImage and backgroundImage.strip() != "":
            bg_image_path = folder_paths.get_annotated_filepath(backgroundImage)
            if os.path.exists(bg_image_path):
                try:
                    bg_image_pil = Image.open(bg_image_path).convert("RGB")
                    bg_image_np = np.array(bg_image_pil)
                    bg_image_resized = cv2.resize(bg_image_np, (output_width_for_dwpose, output_height_for_dwpose), interpolation=cv2.INTER_AREA)
                    
                    dw_pose_gray = cv2.cvtColor(dw_pose_np, cv2.COLOR_RGB2GRAY)
                    _, mask = cv2.threshold(dw_pose_gray, 1, 255, cv2.THRESH_BINARY)
                    dw_combined_np = bg_image_resized.copy()
                    dw_combined_np[mask != 0] = dw_pose_np[mask != 0]
                    dw_combined_image = torch.from_numpy(dw_combined_np.astype(np.float32) / 255.0).unsqueeze(0).clone()
                except Exception as e:
                    pass
        
        # Build the UI data
        timestamp = str(time.time() * 1000)
        random_str = str(random.randint(0, 999999))
        ui_data = {
            "poses_datas": [poses_datas],
            "editdPose": [dw_bg_filename],
            "inputPose": [ld_filepath or ""],
            "backgroundImage": [backgroundImage],
            "refresh_trigger": [f"{timestamp}_{random_str}"],
            "dw_pose_shape": [list(dw_pose_image.shape)],
            "combined_shape": [list(dw_combined_image.shape)],
            "dw_pose_width": [output_width_for_dwpose],
            "dw_pose_height": [output_height_for_dwpose]
        }
        
        # Return the result
        return {
            "ui": ui_data,
            "result": (dw_pose_image, dw_combined_image, output_width_for_dwpose, output_height_for_dwpose)
        }

# ====================================================================================================
# SavePoseToJson node
# ====================================================================================================
class SavePoseToJson:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "pose_point": ("POSE_KEYPOINT",),      # pose keypoint data (includes canvas size)
                "filename_prefix": ("STRING", {"default": "poses/pose"})  # filename prefix for saving
            },
            "optional": {
                "pose_image": ("IMAGE",),  # optionally save the image
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    FUNCTION = "save_json"
    OUTPUT_NODE = True
    CATEGORY = "image"

    def save_json(self, pose_point, filename_prefix="pose", pose_image=None):
        # ========== Core change: get the canvas size from pose_point ==========
        image_width = 512  # default value
        image_height = 512 # default value
        
        # Parse pose_point to get the canvas size
        if pose_point and isinstance(pose_point, list) and len(pose_point) > 0:
            # Take the first element (corresponds to the first object in your JSON array)
            first_pose_data = pose_point[0]
            if isinstance(first_pose_data, dict):
                # Read the canvas size from the pose data
                image_width = first_pose_data.get("canvas_width", 512)
                image_height = first_pose_data.get("canvas_height", 512)

        # ========== Process pose keypoint data ==========
        processed_people = []
        if pose_point and isinstance(pose_point, list) and len(pose_point) > 0:
            for result_dict in pose_point:
                # Safely get the people list
                people_in_dict = result_dict.get("people", []) if isinstance(result_dict, dict) else []
                for person in people_in_dict:
                    if not isinstance(person, dict):
                        continue
                        
                    # Get the raw keypoints and initialize the output array
                    original_keypoints = person.get("pose_keypoints_2d", [])
                    body_keypoints = [0.0] * 54  # 18 keypoints x 3 (x, y, confidence)
                    
                    # Copy and convert keypoints (relative coordinates -> absolute coordinates)
                    num_points_to_copy = min(18, len(original_keypoints) // 3)
                    for i in range(num_points_to_copy):
                        base_idx = i * 3
                        # Safe value access (avoid index out of range)
                        if base_idx + 2 >= len(original_keypoints):
                            continue
                            
                        x = original_keypoints[base_idx]
                        y = original_keypoints[base_idx + 1]
                        confidence = original_keypoints[base_idx + 2]
                        
                        if confidence > 0 and image_width > 0 and image_height > 0:
                            # Convert relative coordinates (0-1) to absolute pixel coordinates
                            absolute_x = x * image_width
                            absolute_y = y * image_height
                            body_keypoints[base_idx] = absolute_x
                            body_keypoints[base_idx + 1] = absolute_y
                            body_keypoints[base_idx + 2] = confidence
                    
                    processed_people.append({
                        "pose_keypoints_2d": body_keypoints
                    })

        # ========== Save JSON file ==========
        # Build the data to save (keep the canvas size info)
        data_to_save = {
            "width": int(image_width),
            "height": int(image_height),
            "canvas_width": int(image_width),   # kept for compatibility with the original field
            "canvas_height": int(image_height), # kept for compatibility with the original field
            "people": processed_people
        }

        # Generate the save path and file name
        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, image_width, image_height
        )
        
        # Make sure the save folder exists
        os.makedirs(full_output_folder, exist_ok=True)
        
        # Handle the file counter (avoid duplicates)
        counter = 1
        try:
            existing_files = [f for f in os.listdir(full_output_folder) 
                             if f.startswith(filename + "_") and f.endswith(".json")]
            if existing_files:
                max_counter = 0
                for f in existing_files:
                    try:
                        num_str = f[len(filename)+1:-5]  # extract the number part
                        num = int(num_str)
                        if num > max_counter:
                            max_counter = num
                    except ValueError:
                        continue
                counter = max_counter + 1
        except FileNotFoundError:
            pass

        # Save the file (UTF-8 encoding, compatible with Chinese)
        final_filename = f"{filename}_{counter:05d}.json"
        file_path = os.path.join(full_output_folder, final_filename)

        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data_to_save, f, indent=4, ensure_ascii=False)

        result_filename = os.path.join(subfolder, final_filename) if subfolder else final_filename

        # ========== Save image file (new feature) ==========
        if pose_image is not None:
            try:
                # Process the first image in the batch
                img_tensor = pose_image[0]
                i = 255. * img_tensor.cpu().numpy()
                img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
                
                image_filename = f"{filename}_{counter:05d}.png"
                image_file_path = os.path.join(full_output_folder, image_filename)
                
                img.save(image_file_path)
            except Exception as e:
                pass
        
        return {"ui": {"text": [result_filename]}, "result": (result_filename,)}


# ====================================================================================================
# Node registration + global fix for the TextConcatenator warning
# ====================================================================================================
NODE_CLASS_MAPPINGS = {
    "Nui.OpenPoseEditor": OpenPoseEditor,
    "SavePoseToJson": SavePoseToJson
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Nui.OpenPoseEditor": "OpenPose Editor (DWPose By DocKr)",
    "SavePoseToJson": "Save Pose to JSON (from Keypoint)"
}

# [Key] Global fix for the TextConcatenator IS_CHANGED warning (solved once and for all)
try:
    from nodes import TextConcatenator
    # Override TextConcatenator's IS_CHANGED method to be compatible with all parameters
    original_tc_is_changed = TextConcatenator.IS_CHANGED
    @classmethod
    def fixed_tc_is_changed(cls, *args, **kwargs):
        return original_tc_is_changed(cls, *args, **kwargs) if callable(original_tc_is_changed) else str(time.time())
    TextConcatenator.IS_CHANGED = fixed_tc_is_changed
except ImportError:
    pass