import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  try {
    // Get first 5 records to inspect structure
    const { data: sampleRecords, error: sampleError } = await supabase
      .from('coatings')
      .select('*')
      .limit(5)

    if (sampleError) {
      throw new Error(`Sample error: ${sampleError.message}`)
    }

    // Get total count
    const { count, error: countError } = await supabase
      .from('coatings')
      .select('*', { count: 'exact', head: true })

    if (countError) {
      throw new Error(`Count error: ${countError.message}`)
    }

    // Get all column names from first record
    const columns = sampleRecords && sampleRecords.length > 0 
      ? Object.keys(sampleRecords[0]) 
      : []

    // Check for family-like columns
    const familyColumns = columns.filter(col => 
      col.toLowerCase().includes('family') || 
      col.toLowerCase().includes('brand') ||
      col.toLowerCase().includes('line')
    )

    // Check for type-like columns
    const typeColumns = columns.filter(col => 
      col.toLowerCase().includes('type') || 
      col.toLowerCase().includes('category') ||
      col.toLowerCase().includes('class')
    )

    // Check for model-like columns
    const modelColumns = columns.filter(col => 
      col.toLowerCase().includes('model') || 
      col.toLowerCase().includes('specification') ||
      col.toLowerCase().includes('spec') ||
      col.toLowerCase().includes('variant')
    )

    // Extract unique values from potential columns
    const extractUniqueValues = (records: any[], columnNames: string[]) => {
      const values = new Set<string>()
      
      records.forEach(record => {
        columnNames.forEach(colName => {
          const value = record[colName]
          if (value && String(value).trim()) {
            values.add(`${colName}: ${String(value).trim()}`)
          }
        })

        // Also check all_attributes
        if (record.all_attributes) {
          try {
            let attributes: any = typeof record.all_attributes === 'string' 
              ? JSON.parse(record.all_attributes) 
              : record.all_attributes

            Object.keys(attributes).forEach(key => {
              if (columnNames.some(col => key.toLowerCase().includes(col.toLowerCase()))) {
                const value = attributes[key]
                if (value && String(value).trim()) {
                  values.add(`all_attributes.${key}: ${String(value).trim()}`)
                }
              }
            })
          } catch (e) {
            // Ignore
          }
        }
      })

      return Array.from(values)
    }

    return NextResponse.json({
      success: true,
      totalRecords: count,
      sampleRecordsCount: sampleRecords?.length || 0,
      allColumns: columns,
      potentialFamilyColumns: familyColumns,
      potentialTypeColumns: typeColumns,
      potentialModelColumns: modelColumns,
      sampleFamilyValues: extractUniqueValues(sampleRecords || [], familyColumns),
      sampleTypeValues: extractUniqueValues(sampleRecords || [], typeColumns),
      sampleModelValues: extractUniqueValues(sampleRecords || [], modelColumns),
      sampleRecords: sampleRecords?.map(record => {
        // Show structure without embedding
        const { embedding, ...rest } = record
        return rest
      })
    })

  } catch (error: any) {
    console.error('❌ Debug error:', error)
    return NextResponse.json(
      { 
        success: false,
        error: error.message 
      },
      { status: 500 }
    )
  }
}
