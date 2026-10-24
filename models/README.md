# Models

## `face_detection_yunet_2023mar.onnx`

Face Lock's face detector (`lib/face-detect.js`, used by `lib/face-lock.js`).
YuNet from the OpenCV Zoo, MIT licence, about 230 KB. It finds each face and
five landmarks (eyes, nose tip, mouth corners), so the original photo's faces
can be laid back into a Reframe or AI Upscale result.

Source:
https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

The Dockerfile copies this folder into the image. Without the file the server
still runs, Face Lock is just off, and the server log says so on the first
Reframe.
