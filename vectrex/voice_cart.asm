;==============================================================================
; Example Vectrex cartridge: plays one voice matching stream, pauses for a
; second, and plays it again (AS09 syntax).
;
; 1. In the tool, match at 50 Hz with machine Vectrex, then press
;    "Save Vectrex .asm" (the whole match, or a selected part).
; 2. Save it next to this file as stream.asm.
; 3. Set VOICE (at the end of this file) to the label at the top of
;    stream.asm, for example VM_my_recording.
; 4. Assemble this file, for example: as09 -i voice_cart.asm -o voice_cart.bin
;
; The player (vtx_voice_player.asm) needs 4 bytes of RAM (VM_RAM) and is
; called once a frame: VM_Service puts the update's registers into the BIOS
; sound buffer, and the BIOS Do_Sound writes them to the AY.
;==============================================================================

Wait_Recal      equ    $F192
Do_Sound        equ    $F289
VM_RAM          equ    $C880                  ; the player's 4 bytes
Pause           equ    $C884                  ; frames left in the pause

        org    0
        fcc    "g GCE 2026"
        fcb    $80
        fdb    $FD0D
        fcb    $F8,$50,$20,-$56
        fcc    "VOICE"
        fcb    $80
        fcb    0

        ldx    #$C83F                         ; Vec_Music_Work: all registers 0
        ldb    #14
clear:
        clr    ,x+
        decb
        bne    clear
        lda    #$3F                           ; mixer: every tone and noise off
        sta    $C83F+6
        clr    VM_RAM+2                       ; the player starts silent
        clr    Pause

frame:
        jsr    Wait_Recal
        jsr    VM_Busy
        bne    playing
        lda    Pause                          ; silent: count the pause down,
        beq    again                          ; then start the voice again
        dec    Pause
        bra    sound
again:
        lda    #50                            ; one second after this play
        sta    Pause
        ldx    #VOICE
        jsr    VM_Start
playing:
        jsr    VM_Service
sound:
        jsr    Do_Sound
        bra    frame

        include "vtx_voice_player.asm"
        include "stream.asm"

VOICE           equ    VM_Stream              ; the label at the top of stream.asm
