package com.tesis.dronepatrol.drone

import com.tesis.dronepatrol.dji.DjiDroneController

object ControllerFactory {
    fun create(): DroneController = DjiDroneController()
}
