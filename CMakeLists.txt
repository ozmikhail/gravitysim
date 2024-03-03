cmake_minimum_required(VERSION 3.24)

project(gravity_simulator
    DESCRIPTION "CUDA-accelerated real-time N-body gravitational simulator"
    LANGUAGES C CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(APPLE)
    set(_default_build_cuda OFF)
else()
    set(_default_build_cuda ON)
endif()
option(BUILD_CUDA "Build CUDA backend" ${_default_build_cuda})
option(BUILD_TESTS "Build tests" ON)

if(BUILD_CUDA)
    enable_language(CUDA)
endif()

find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(_grav_venv_dir ${CMAKE_BINARY_DIR}/_grav_venv)
if(NOT EXISTS ${_grav_venv_dir}/bin/python)
    message(STATUS "creating build venv at ${_grav_venv_dir}")
    execute_process(
        COMMAND ${Python3_EXECUTABLE} -m venv ${_grav_venv_dir}
        RESULT_VARIABLE _venv_rc
    )
    if(NOT _venv_rc EQUAL 0)
        message(FATAL_ERROR "failed to create build venv with ${Python3_EXECUTABLE}")
    endif()
    execute_process(
        COMMAND ${_grav_venv_dir}/bin/pip install --quiet --disable-pip-version-check jinja2
        RESULT_VARIABLE _pip_rc
    )
    if(NOT _pip_rc EQUAL 0)
        message(FATAL_ERROR "failed to install jinja2 in build venv")
    endif()
endif()
set(Python3_EXECUTABLE ${_grav_venv_dir}/bin/python CACHE FILEPATH "" FORCE)
set(Python_EXECUTABLE  ${_grav_venv_dir}/bin/python CACHE FILEPATH "" FORCE)

include(FetchContent)
set(FETCHCONTENT_QUIET ON)

FetchContent_Declare(
    tomlplusplus
    GIT_REPOSITORY https://github.com/marzer/tomlplusplus.git
    GIT_TAG        v3.4.0
)

set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_DOCS     OFF CACHE BOOL "" FORCE)
set(GLFW_INSTALL        OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    glfw
    GIT_REPOSITORY https://github.com/glfw/glfw.git
    GIT_TAG        3.4
)

FetchContent_Declare(
    glad
    GIT_REPOSITORY https://github.com/Dav1dde/glad.git
    GIT_TAG        v2.0.6
    SOURCE_SUBDIR  cmake
)

FetchContent_Declare(
    imgui
    GIT_REPOSITORY https://github.com/ocornut/imgui.git
    GIT_TAG        v1.91.5
)

if(BUILD_TESTS)
    FetchContent_Declare(
        Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG        v3.7.1
    )
endif()

if(BUILD_TESTS)
    FetchContent_MakeAvailable(tomlplusplus glfw glad imgui Catch2)
    list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)
    enable_testing()
else()
    FetchContent_MakeAvailable(tomlplusplus glfw glad imgui)
endif()

if(APPLE AND NOT DEFINED OpenMP_ROOT AND EXISTS "/opt/homebrew/opt/libomp")
    set(OpenMP_ROOT "/opt/homebrew/opt/libomp" CACHE PATH "" FORCE)
endif()
find_package(OpenMP COMPONENTS CXX)
if(NOT OpenMP_CXX_FOUND)
    message(STATUS "openmp: NOT FOUND - cpu_step will run single-threaded")
    if(APPLE)
        message(STATUS "        on macOS run: brew install libomp")
    endif()
endif()

glad_add_library(glad_gl_core_43 STATIC API gl:core=4.3)

add_library(imgui STATIC
    ${imgui_SOURCE_DIR}/imgui.cpp
    ${imgui_SOURCE_DIR}/imgui_demo.cpp
    ${imgui_SOURCE_DIR}/imgui_draw.cpp
    ${imgui_SOURCE_DIR}/imgui_tables.cpp
    ${imgui_SOURCE_DIR}/imgui_widgets.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp
)
target_include_directories(imgui SYSTEM PUBLIC
    ${imgui_SOURCE_DIR}
    ${imgui_SOURCE_DIR}/backends
)
target_link_libraries(imgui PUBLIC glfw)

add_subdirectory(core)
