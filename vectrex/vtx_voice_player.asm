;==============================================================================
; VTX voice matching stream player for the Vectrex (AS09 syntax).
;
; Plays the register stream made by the voice matching tool (core.js,
; encodeStream): one update per 50 Hz frame. Each update is a 2-byte mask,
; high byte first (low byte bits 0-7 = R0-R7, high byte bits 0-5 = R8-R13),
; then the values of the set registers in order R0..R13. $80 $00 ends it.
;
; Define before including:
;   VM_RAM   equ  $C880          ; 4 bytes
;
; Routines (all may clobber A, B, X; DP any on entry, preserved):
;   VM_Start     X = stream; starts at the next VM_Service
;   VM_Busy      Z = 1 when silent
;   VM_Stop      silence now
;   VM_Service   once per frame, before Do_Sound: puts the update's changed
;                registers into the BIOS sound buffer (Vec_Music_Work)
;
; The player owns all three channels while it plays. R13 is only in the
; stream when the envelope must restart: Do_Sound writes a register only when
; it differs from its shadow copy, so the player spoils the shadow's R13 to
; force the write (the same trick as the VTX Speech player).
; Every address is extended (DP is never assumed).
;==============================================================================

VM_Work         equ    $C83F                  ; Vec_Music_Work: R13 at $C83F ... R0 at $C84C
VM_Shadow_R13   equ    $C80D                  ; Do_Sound's shadow of R13

VM_Ptr          equ    VM_RAM                 ; 2 bytes: next update
VM_On           equ    VM_RAM+2               ; 1 byte: playing
VM_MaskHi       equ    VM_RAM+3               ; 1 byte: the update's R8-R13 bits

VM_Start:
        stx    >VM_Ptr
        lda    #1
        sta    >VM_On
        rts

VM_Busy:
        tst    >VM_On
        rts

VM_Stop:
        clr    >VM_On
VM_Silence:                                   ; mixer: every tone and noise off (bits 6-7 stay 0:
        lda    #$3F                           ; the Vectrex reads its buttons through port A)
        sta    >VM_Work+13-7
        clr    >VM_Work+13-8                  ; volumes 0
        clr    >VM_Work+13-9
        clr    >VM_Work+13-10
        rts

VM_Service:
        tst    >VM_On
        lbeq   VM_Done                        ; long: the unrolled body is over 127 bytes
        ldx    >VM_Ptr
        ldd    ,x++                           ; A = high mask byte, B = low mask byte
        lbmi   VM_End                         ; bit 15: end of the stream
        sta    >VM_MaskHi
        ; R0..R7: B holds their bits; A carries each value.
        bitb   #$01
        beq    VM_N0
        lda    ,x+
        sta    >VM_Work+13-0
VM_N0:  bitb   #$02
        beq    VM_N1
        lda    ,x+
        sta    >VM_Work+13-1
VM_N1:  bitb   #$04
        beq    VM_N2
        lda    ,x+
        sta    >VM_Work+13-2
VM_N2:  bitb   #$08
        beq    VM_N3
        lda    ,x+
        sta    >VM_Work+13-3
VM_N3:  bitb   #$10
        beq    VM_N4
        lda    ,x+
        sta    >VM_Work+13-4
VM_N4:  bitb   #$20
        beq    VM_N5
        lda    ,x+
        sta    >VM_Work+13-5
VM_N5:  bitb   #$40
        beq    VM_N6
        lda    ,x+
        sta    >VM_Work+13-6
VM_N6:  bitb   #$80
        beq    VM_N7
        lda    ,x+
        sta    >VM_Work+13-7
VM_N7:  ; R8..R13: the high mask byte.
        ldb    >VM_MaskHi
        beq    VM_Saved                       ; none of R8-R13 changed
        bitb   #$01
        beq    VM_N8
        lda    ,x+
        sta    >VM_Work+13-8
VM_N8:  bitb   #$02
        beq    VM_N9
        lda    ,x+
        sta    >VM_Work+13-9
VM_N9:  bitb   #$04
        beq    VM_N10
        lda    ,x+
        sta    >VM_Work+13-10
VM_N10: bitb   #$08
        beq    VM_N11
        lda    ,x+
        sta    >VM_Work+13-11
VM_N11: bitb   #$10
        beq    VM_N12
        lda    ,x+
        sta    >VM_Work+13-12
VM_N12: bitb   #$20
        beq    VM_Saved
        lda    ,x+                            ; R13: the envelope restarts
        sta    >VM_Work+13-13
        lda    #$FF                           ; spoil the shadow so Do_Sound writes R13
        sta    >VM_Shadow_R13
VM_Saved:
        stx    >VM_Ptr
VM_Done:
        rts
VM_End:
        clr    >VM_On
        bra    VM_Silence
