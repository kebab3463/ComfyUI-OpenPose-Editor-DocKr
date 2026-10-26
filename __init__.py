import sys
import subprocess
import os
import importlib.util

def check_and_install_dependencies():
    # Get the directory containing this file
    current_dir = os.path.dirname(os.path.abspath(__file__))
    requirements_path = os.path.join(current_dir, "requirements.txt")
    
    if not os.path.exists(requirements_path):
        return

    try:
        with open(requirements_path, 'r') as f:
            requirements = [line.strip() for line in f if line.strip() and not line.startswith('#')]
        
        for req in requirements:
            # Simple package name extraction (e.g. "numpy<2" -> "numpy")
            pkg_name = req.split('==')[0].split('>=')[0].split('<=')[0].split('<')[0].split('>')[0].strip()
            
            # Special handling for opencv
            if pkg_name == "opencv-python":
                pkg_name = "cv2"
            elif pkg_name == "Pillow":
                pkg_name = "PIL"
            
            spec = importlib.util.find_spec(pkg_name)
            if spec is None:
                try:
                    subprocess.check_call([sys.executable, "-m", "pip", "install", req])
                except Exception:
                    pass
                
    except Exception:
        pass

# Run the dependency check
check_and_install_dependencies()

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./js"
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
