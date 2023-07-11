add_library(error_lib STATIC
    src/error.cpp
)
target_include_directories(error_lib PUBLIC src)

add_library(metrics_lib STATIC
    src/modules/metrics/metrics.cpp
)
target_include_directories(metrics_lib PUBLIC src)

add_library(sim_lib STATIC
    src/modules/sim/particles.cpp
    src/modules/sim/simulation.cpp
)
target_include_directories(sim_lib PUBLIC src)
target_link_libraries(sim_lib PUBLIC error_lib)

add_library(scenarios_lib STATIC
    src/modules/scenarios/random_cluster.cpp
    src/modules/scenarios/solar_system.cpp
    src/modules/scenarios/colliding_galaxies.cpp
)
target_include_directories(scenarios_lib PUBLIC src)
target_link_libraries(scenarios_lib PUBLIC sim_lib)

add_library(openmp_adapter STATIC
    src/lib/openmp/nbody_cpu.cpp
)
target_include_directories(openmp_adapter PUBLIC src)
target_link_libraries(openmp_adapter PUBLIC sim_lib)
if(OpenMP_CXX_FOUND)
    target_link_libraries(openmp_adapter PUBLIC OpenMP::OpenMP_CXX)
endif()

add_library(window_adapter STATIC
    src/lib/window/window.cpp
)
target_include_directories(window_adapter PUBLIC src)
target_link_libraries(window_adapter PUBLIC glfw error_lib)

add_library(gl_adapter STATIC
    src/lib/gl/gl.cpp
    src/lib/gl/shader.cpp
)
target_include_directories(gl_adapter PUBLIC src)
target_link_libraries(gl_adapter PUBLIC glad_gl_core_43 glfw error_lib)

add_library(imgui_layer STATIC
    src/lib/imgui_layer/imgui_layer.cpp
)
target_include_directories(imgui_layer PUBLIC src)
target_link_libraries(imgui_layer PUBLIC imgui error_lib)

add_library(render_lib STATIC
    src/modules/render/particle_renderer.cpp
)
target_include_directories(render_lib PUBLIC src)
target_link_libraries(render_lib PUBLIC sim_lib gl_adapter)

add_library(ui_lib STATIC
    src/modules/ui/metrics_overlay.cpp
    src/modules/ui/controls.cpp
)
target_include_directories(ui_lib PUBLIC src)
target_link_libraries(ui_lib PUBLIC imgui metrics_lib sim_lib scenarios_lib)

add_executable(simulator
    src/main.cpp
    src/config.cpp
)
target_include_directories(simulator PRIVATE src)
target_link_libraries(simulator PRIVATE
    tomlplusplus::tomlplusplus
    window_adapter
    imgui_layer
    ui_lib
    render_lib
    scenarios_lib
    openmp_adapter
)

target_compile_options(simulator PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wall;-Wextra;-Wpedantic>
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
)

set_target_properties(simulator PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
)

if(BUILD_TESTS)
    add_subdirectory(tests)
endif()
