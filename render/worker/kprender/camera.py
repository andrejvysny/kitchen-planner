"""The framed camera, rebuilt from the manifest's viewport pose.

Two deliberate choices:

``sensor_fit = 'VERTICAL'``
    The manifest records a **vertical** fov (three's ``PerspectiveCamera.fov``
    is vertical), and the render tier may not use the viewport's aspect —
    preview is 16:9 regardless.  Fitting the sensor vertically makes
    ``angle_y`` authoritative, so the framing a user set up survives any output
    aspect: a wider render reveals more at the sides instead of cropping the
    top and bottom.

**Track-To constraint instead of quaternion maths**
    The manifest gives a position and a look-at target.  Aiming an object at a
    point is exactly what Blender's Track-To constraint does — with
    ``TRACK_NEGATIVE_Z``/``UP_Y``, the camera convention — and letting Blender
    evaluate it means one fewer hand-rolled rotation to get wrong, plus a
    ``--save-blend`` a human can grab and re-aim by moving the empty.
"""

from __future__ import annotations

from math import radians
from typing import Any

import bpy

from .convert import to_blender
from .manifest import Manifest

__all__ = ["setup"]


def setup(manifest: Manifest, scene: Any = None) -> Any:
    """Create the camera + its target empty and make it the scene camera."""
    scene = scene or bpy.context.scene
    cam = manifest.camera

    data = bpy.data.cameras.new("KP Camera")
    # Order matters: sensor_fit decides which of angle_x/angle_y is the driver.
    data.sensor_fit = "VERTICAL"
    data.angle_y = radians(cam.fov_y_deg)
    data.clip_start = cam.near_m
    data.clip_end = cam.far_m

    obj = bpy.data.objects.new("KP Camera", data)
    scene.collection.objects.link(obj)
    obj.location = to_blender(cam.position)

    target = bpy.data.objects.new("KP Camera Target", None)
    target.empty_display_size = 0.1
    target.location = to_blender(cam.target)
    scene.collection.objects.link(target)

    constraint = obj.constraints.new("TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"

    scene.camera = obj
    scene.render.resolution_x = manifest.render.width_px
    scene.render.resolution_y = manifest.render.height_px
    return obj
