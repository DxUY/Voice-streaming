cmake_minimum_required(VERSION 3.16.0)
list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_SOURCE_DIR}/dependencies/esp-skainet/components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(VoiceStreaming)
