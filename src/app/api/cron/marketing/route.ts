import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enviarEmail } from '@/lib/email'

// Token de seguridad
const CRON_SECRET = process.env.CRON_SECRET || 'fideliqr-cron-secret-2024'

// GET - Procesar campañas programadas y enviar
export async function GET(request: NextRequest) {
  const startTime = Date.now()
  
  try {
    // Verificar autorización
    const authHeader = request.headers.get('authorization')
    const urlSecret = request.nextUrl.searchParams.get('secret')
    
    const providedSecret = authHeader?.replace('Bearer ', '') || urlSecret
    
    if (providedSecret !== CRON_SECRET) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const resultados = {
      campanasEncontradas: 0,
      campanasEnviadas: 0,
      totalEmailsEnviados: 0,
      totalErrores: 0,
      detalles: [] as string[]
    }

    const ahora = new Date()

    // 1. Buscar campañas programadas que ya deben enviarse
    const campanasProgramadas = await db.marketing.findMany({
      where: {
        estado: 'programado',
        fechaProgramada: {
          lte: ahora
        }
      }
    })

    resultados.campanasEncontradas = campanasProgramadas.length
    resultados.detalles.push(`Se encontraron ${campanasProgramadas.length} campañas programadas para enviar`)

    // Obtener negocio
    const negocio = await db.negocio.findFirst()
    const nombreNegocio = negocio?.nombre || 'FideliQR'

    // 2. Procesar cada campaña programada
    for (const campana of campanasProgramadas) {
      let enviados = 0
      let errores = 0

      // Obtener clientes según el filtro
      const where = campana.destinatarios === 'inactivos'
        ? { activo: true, totalVisitas: 0 }
        : { activo: true }

      const clientes = await db.cliente.findMany({
        where,
        select: { email: true, nombre: true }
      })

      resultados.detalles.push(`Campaña "${campana.titulo}": ${clientes.length} destinatarios`)

      // Enviar a cada cliente
      for (const cliente of clientes) {
        if (!cliente.email) continue

        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">${campana.titulo}</h2>
            <p style="font-size: 16px; line-height: 1.6;">${campana.mensaje.replace(/\n/g, '<br>')}</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
            <p style="color: #6b7280; font-size: 14px; text-align: center;">
              <strong>${nombreNegocio}</strong><br>
              Este mensaje fue enviado a ${cliente.email}<br>
              porque eres parte de nuestro programa de fidelización.
            </p>
          </div>
        `

        const result = await enviarEmail({
          to: cliente.email,
          subject: `${campana.titulo} - ${nombreNegocio}`,
          html,
        })

        if (result.success) {
          enviados++
        } else {
          errores++
        }

        // Pequeña pausa para no saturar
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      // Actualizar campaña
      await db.marketing.update({
        where: { id: campana.id },
        data: {
          estado: 'enviado',
          enviados,
          errores,
          fechaEnvio: new Date()
        }
      })

      // Si tiene repetición, crear la siguiente campaña
      if (campana.repetir) {
        const siguienteFecha = calcularSiguienteFecha(new Date(), campana.repetir)
        await db.marketing.create({
          data: {
            tipo: campana.tipo,
            titulo: campana.titulo,
            mensaje: campana.mensaje,
            destinatarios: campana.destinatarios,
            estado: 'programado',
            fechaProgramada: siguienteFecha,
            repetir: campana.repetir,
          }
        })
        resultados.detalles.push(`🔄 Próxima campaña programada para ${siguienteFecha.toLocaleString('es-ES')}`)
      }

      resultados.campanasEnviadas++
      resultados.totalEmailsEnviados += enviados
      resultados.totalErrores += errores
      resultados.detalles.push(`✅ "${campana.titulo}" enviada: ${enviados} éxitos, ${errores} errores`)
    }

    // 3. También procesar campañas pendientes (sin fecha programada)
    const campanasPendientes = await db.marketing.findMany({
      where: { estado: 'pendiente' }
    })

    for (const campana of campanasPendientes) {
      let enviados = 0
      let errores = 0

      const where = campana.destinatarios === 'inactivos'
        ? { activo: true, totalVisitas: 0 }
        : { activo: true }

      const clientes = await db.cliente.findMany({
        where,
        select: { email: true, nombre: true }
      })

      for (const cliente of clientes) {
        if (!cliente.email) continue

        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">${campana.titulo}</h2>
            <p style="font-size: 16px; line-height: 1.6;">${campana.mensaje.replace(/\n/g, '<br>')}</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
            <p style="color: #6b7280; font-size: 14px; text-align: center;">
              <strong>${nombreNegocio}</strong>
            </p>
          </div>
        `

        const result = await enviarEmail({
          to: cliente.email,
          subject: `${campana.titulo} - ${nombreNegocio}`,
          html,
        })

        if (result.success) enviados++
        else errores++

        await new Promise(resolve => setTimeout(resolve, 100))
      }

      await db.marketing.update({
        where: { id: campana.id },
        data: {
          estado: 'enviado',
          enviados,
          errores,
          fechaEnvio: new Date()
        }
      })

      resultados.campanasEnviadas++
      resultados.totalEmailsEnviados += enviados
      resultados.totalErrores += errores
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      fecha: new Date().toISOString(),
      duracion: `${duration}ms`,
      ...resultados
    })

  } catch (error) {
    console.error('Error en cron de marketing:', error)
    return NextResponse.json({ 
      success: false, 
      error: String(error),
      fecha: new Date().toISOString()
    }, { status: 500 })
  }
}

// Función auxiliar para calcular siguiente fecha según repetición
function calcularSiguienteFecha(fechaActual: Date, repetir: string): Date {
  const siguiente = new Date(fechaActual)
  
  switch (repetir) {
    case 'diario':
      siguiente.setDate(siguiente.getDate() + 1)
      break
    case 'semanal':
      siguiente.setDate(siguiente.getDate() + 7)
      break
    case 'mensual':
      siguiente.setMonth(siguiente.getMonth() + 1)
      break
    default:
      siguiente.setDate(siguiente.getDate() + 1)
  }
  
  return siguiente
}
