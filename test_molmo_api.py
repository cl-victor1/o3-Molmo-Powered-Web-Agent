import json
import base64
import requests
import os
from io import BytesIO
from PIL import Image
from dotenv import load_dotenv

load_dotenv()
MOLMO_API_KEY = os.environ["MOLMO_API_KEY"]

def image_to_base64(image_path):
    image = Image.open(image_path)  # Convert NumPy array to PIL image
    buffered = BytesIO()
    image.save(buffered, format="PNG")  # Save to buffer as PNG
    return base64.b64encode(buffered.getvalue()).decode("utf-8")  # Encode to base64

def query_mlm_api(api_url, instruction, image):
    if isinstance(image, str):
        if not image.startswith("http") and os.path.exists(image):
            # If the image is a file path, convert it to base64
            image = image_to_base64(image)

    
    payload = {"input_text": [instruction], "input_image": [image]}
    try:
        response = requests.post(
            api_url,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {MOLMO_API_KEY}"},
            data=json.dumps(payload),
            stream=True,
        )

        if response.status_code != 200:
            print("[ERROR] API failed:", response.text)
            return None

        response_text = ""
        for chunk in response.iter_lines():
            if chunk:
                content = json.loads(chunk)["result"]["output"]["text"]
                response_text += content
        return response_text  # Return full text response

    except Exception as e:
        print(f"[ERROR] Failed to query API: {str(e)}")
        return None

def query_llm_api(api_url, instruction):
    # need to double check the allowed values for model_version_id and opts
    model_version_id = api_url.replace("https://ai2-reviz--", "").replace("-combo.modal.run/completion", "")
    # print(model_version_id)
    payload = {
        "input": {
            "messages": [{"role": "user", "content": instruction}],
            "opts": {"temperature": 0, "max_tokens": 512},
        }, 
         "model_version_id": model_version_id}
    try:
        response = requests.post(
            api_url,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {MOLMO_API_KEY}"},
            data=json.dumps(payload),
            stream=True,
        )

        if response.status_code != 200:
            print("[ERROR] API failed:", response.text)
            return None

        response_text = ""
        for chunk in response.iter_lines():
            if chunk:
                content = json.loads(chunk)["result"]["output"]["text"]
                response_text += content
        return response_text  # Return full text response

    except Exception as e:
        print(f"[ERROR] Failed to query API: {str(e)}")
        return None

    
if __name__ == "__main__":
    # Example usage
    # api_url = "https://ai2-reviz--olmoe-1b-7b-0125-instruct-combo.modal.run/completion"
    # api_url = "https://ai2-reviz--olmo-2-0325-32b-instruct-combo.modal.run/completion"
    # api_url = "https://ai2-reviz--olmo-2-1124-13b-instruct-combo.modal.run/completion"
    # response = query_llm_api(api_url, "tell me a joke")
    # print(response)

    api_url = "https://ai2-reviz--uber-model-v4-synthetic.modal.run/completion_stream"
    image = "1721697383-wildlands-trees.jpg"
    instruction = "point to the trees"
    # image = "/weka/oe-training-default/zixianm/WebOlmo/data/images/amazon/amazon0-1.jpg"
    # instruction = "point to Amazon"
    response = query_mlm_api(
        api_url,
        instruction, 
        image # a URL or a local file path
    )
    print(response)