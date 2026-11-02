/*
 * Software renderer for tzo-anim programs.
 *
 * This mirrors the animation extension of tzo-c's anim.c:
 *   - textures are RGBA buffers plus the hotspot offsets given to loadImage()
 *   - drawFrame(n) blits texture n at (-hotspotX, -hotspotY)
 *   - the frame buffer is *persistent* (anim.c never clears blit_screen_0), so
 *     a program that draws its background once keeps it on screen
 *   - endDraw() presents the whole buffer
 *
 * Unlike anim.c (which converts everything to an indexed palette and copies
 * every pixel), this renderer keeps the alpha channel, so sprites are properly
 * transparent.
 */

export class Renderer {
    constructor() {
        this.textures = [];
        this.width = 0;
        this.height = 0;
        this.buffer = new Uint8ClampedArray(0);
        this.originX = 0;
        this.originY = 0;
        this.drawCalls = 0;
        this.presentCalls = 0;
        this.offscreen = null;
        this.offscreenContext = null;
        this.imageData = null;
    }

    reset() {
        this.textures = [];
        this.width = 0;
        this.height = 0;
        this.buffer = new Uint8ClampedArray(0);
        this.originX = 0;
        this.originY = 0;
        this.drawCalls = 0;
        this.presentCalls = 0;
        this.imageData = null;
    }

    /**
     * @param {{width: number, height: number, data: Uint8ClampedArray, hotspotX: number, hotspotY: number}} texture
     * @returns {number} the texture index used by drawFrame
     */
    addTexture(texture) {
        this.textures.push(texture);
        return this.textures.length - 1;
    }

    /**
     * Size the scene to the bounding box of all textures, taking the hotspot
     * offsets into account. anim.c sizes its blit buffer to
     * max(width - hotspotX) which crops sprites with positive offsets; using the
     * full bounding box shows everything.
     */
    fitToTextures() {
        if (this.textures.length === 0) {
            this.width = 0;
            this.height = 0;
            this.buffer = new Uint8ClampedArray(0);
            this.imageData = null;
            return;
        }

        let minX = 0;
        let minY = 0;
        let maxX = 1;
        let maxY = 1;

        for (const texture of this.textures) {
            const left = -texture.hotspotX;
            const top = -texture.hotspotY;
            minX = Math.min(minX, left);
            minY = Math.min(minY, top);
            maxX = Math.max(maxX, left + texture.width);
            maxY = Math.max(maxY, top + texture.height);
        }

        // `|| 0` normalises -0 to 0 (Math.min(0, -0) returns -0).
        this.originX = minX || 0;
        this.originY = minY || 0;
        this.width = Math.max(1, Math.ceil(maxX - minX));
        this.height = Math.max(1, Math.ceil(maxY - minY));
        this.buffer = new Uint8ClampedArray(this.width * this.height * 4);
        this.imageData = null;
    }

    clear() {
        this.buffer.fill(0);
    }

    /** anim.c's drawFrame: blit a texture relative to the hotspot. */
    drawTexture(index) {
        const texture = this.textures[index];
        if (!texture || this.width === 0) {
            return false;
        }
        this.drawCalls++;
        this.blit(texture, -texture.hotspotX - this.originX, -texture.hotspotY - this.originY);
        return true;
    }

    /**
     * Alpha-blit a texture into the frame buffer, clipped to its bounds.
     * Fully opaque pixels are copied (so redrawing a frame is idempotent, just
     * like anim.c's indexed copy), partial alpha is composited.
     */
    blit(texture, x, y) {
        const { width: textureWidth, height: textureHeight, data } = texture;
        const startX = Math.max(0, -x);
        const startY = Math.max(0, -y);
        const endX = Math.min(textureWidth, this.width - x);
        const endY = Math.min(textureHeight, this.height - y);

        if (startX >= endX || startY >= endY) {
            return;
        }

        for (let sourceY = startY; sourceY < endY; sourceY++) {
            let sourceIndex = (sourceY * textureWidth + startX) * 4;
            let destIndex = ((y + sourceY) * this.width + (x + startX)) * 4;

            for (let sourceX = startX; sourceX < endX; sourceX++, sourceIndex += 4, destIndex += 4) {
                const alpha = data[sourceIndex + 3];
                if (alpha === 0) {
                    continue;
                }
                if (alpha === 255) {
                    this.buffer[destIndex] = data[sourceIndex];
                    this.buffer[destIndex + 1] = data[sourceIndex + 1];
                    this.buffer[destIndex + 2] = data[sourceIndex + 2];
                    this.buffer[destIndex + 3] = 255;
                    continue;
                }

                const sourceAlpha = alpha / 255;
                const destAlpha = this.buffer[destIndex + 3] / 255;
                const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
                if (outAlpha === 0) {
                    continue;
                }
                const keep = destAlpha * (1 - sourceAlpha);
                this.buffer[destIndex] = (data[sourceIndex] * sourceAlpha + this.buffer[destIndex] * keep) / outAlpha;
                this.buffer[destIndex + 1] = (data[sourceIndex + 1] * sourceAlpha + this.buffer[destIndex + 1] * keep) / outAlpha;
                this.buffer[destIndex + 2] = (data[sourceIndex + 2] * sourceAlpha + this.buffer[destIndex + 2] * keep) / outAlpha;
                this.buffer[destIndex + 3] = outAlpha * 255;
            }
        }
    }

    /** Copy the frame buffer to a canvas. No-op when running without a DOM. */
    present(canvas) {
        if (this.width === 0 || this.height === 0) {
            return;
        }
        // Count the presentation even when running headless (node tests).
        this.presentCalls++;
        if (!canvas) {
            return;
        }

        if (!this.offscreen) {
            this.offscreen = document.createElement('canvas');
            this.offscreenContext = this.offscreen.getContext('2d');
        }
        if (this.offscreen.width !== this.width || this.offscreen.height !== this.height) {
            this.offscreen.width = this.width;
            this.offscreen.height = this.height;
            this.imageData = this.offscreenContext.createImageData(this.width, this.height);
        }
        if (!this.imageData) {
            this.imageData = this.offscreenContext.createImageData(this.width, this.height);
        }

        this.imageData.data.set(this.buffer);
        this.offscreenContext.putImageData(this.imageData, 0, 0);

        if (canvas.width !== this.width) {
            canvas.width = this.width;
        }
        if (canvas.height !== this.height) {
            canvas.height = this.height;
        }
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(this.offscreen, 0, 0);
    }
}
