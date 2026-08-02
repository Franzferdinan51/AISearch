FROM searxng/searxng:latest

# Bake the JSON-enabled local settings into the image. A host bind mount can
# trigger file-lock issues on macOS VM-backed Docker runtimes.
COPY settings.yml /etc/searxng/settings.yml
