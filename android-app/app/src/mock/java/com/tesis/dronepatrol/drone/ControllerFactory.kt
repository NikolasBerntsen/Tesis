package com.tesis.dronepatrol.drone

object ControllerFactory {
    fun create(): DroneController = SimulatedDroneController()
}
